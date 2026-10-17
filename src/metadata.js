const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_METADATA_LENGTH = 10_000;

function ipv4ToNumber(address) {
    return address.split('.').reduce((result, octet) => (result * 256) + Number(octet), 0);
}

function ipv6ToBigInt(address) {
    const parts = address.toLowerCase().split('::');
    if (parts.length > 2) return null;

    const parsePart = (part) => {
        if (!part) return [];
        return part.split(':').flatMap((piece) => {
            if (!piece.includes('.')) return [parseInt(piece, 16)];
            if (!net.isIPv4(piece)) return [Number.NaN, Number.NaN];
            const value = ipv4ToNumber(piece);
            return [value >>> 16, value & 0xffff];
        });
    };

    const left = parsePart(parts[0]);
    const right = parts.length === 2 ? parsePart(parts[1]) : [];
    const missing = parts.length === 2 ? 8 - left.length - right.length : 0;
    if (missing < 0 || (parts.length === 1 && left.length !== 8) || [...left, ...right].some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
        return null;
    }

    return [...left, ...Array(missing).fill(0), ...right]
        .reduce((result, part) => (result << 16n) | BigInt(part), 0n);
}

function isInIpv6Range(address, prefix, bits) {
    const value = ipv6ToBigInt(address);
    const network = ipv6ToBigInt(prefix);
    if (value === null || network === null) return false;
    const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (value & mask) === (network & mask);
}

function mappedIpv4Address(address) {
    const value = ipv6ToBigInt(address);
    if (value === null || !isInIpv6Range(address, '::ffff:0:0', 96)) return null;
    const mapped = Number(value & 0xffffffffn);
    return [
        (mapped >>> 24) & 0xff,
        (mapped >>> 16) & 0xff,
        (mapped >>> 8) & 0xff,
        mapped & 0xff
    ].join('.');
}

function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const value = ipv4ToNumber(address);
        return value <= 0x00ffffff ||
            (value >= 0x0a000000 && value <= 0x0affffff) ||
            (value >= 0x64400000 && value <= 0x647fffff) ||
            (value >= 0x7f000000 && value <= 0x7fffffff) ||
            (value >= 0xa9fe0000 && value <= 0xa9feffff) ||
            (value >= 0xac100000 && value <= 0xac1fffff) ||
            (value >= 0xc0000000 && value <= 0xc00000ff) ||
            (value >= 0xc0000200 && value <= 0xc00002ff) ||
            (value >= 0xc6120000 && value <= 0xc613ffff) ||
            (value >= 0xc6336400 && value <= 0xc63364ff) ||
            (value >= 0xcb007100 && value <= 0xcb0071ff) ||
            (value >= 0xc0a80000 && value <= 0xc0a8ffff) ||
            value >= 0xe0000000;
    }

    if (net.isIPv6(address)) {
        const normalized = address.toLowerCase();
        if (isInIpv6Range(normalized, '::', 96) ||
            isInIpv6Range(normalized, '::1', 128) ||
            isInIpv6Range(normalized, 'fc00::', 7) ||
            isInIpv6Range(normalized, 'fe80::', 10) ||
            isInIpv6Range(normalized, 'ff00::', 8) ||
            isInIpv6Range(normalized, '2001:2::', 48) ||
            isInIpv6Range(normalized, '2001:db8::', 32)) {
            return true;
        }

        const mappedIpv4 = mappedIpv4Address(normalized);
        if (mappedIpv4) return isPrivateAddress(mappedIpv4);
        return false;
    }

    return true;
}

async function assertSafeUrl(rawUrl) {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP and HTTPS metadata URLs are supported');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Metadata URLs cannot contain credentials');
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('Private metadata hosts are not allowed');
    }

    if (net.isIP(hostname)) {
        if (isPrivateAddress(hostname)) throw new Error('Private metadata hosts are not allowed');
        return parsed;
    }

    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
        throw new Error('Private metadata hosts are not allowed');
    }
    return { parsed, address: addresses[0].address, family: addresses[0].family };
}

function limitText(value) {
    return String(value || '').trim().slice(0, MAX_METADATA_LENGTH);
}

async function fetchMetadata(url) {
    try {
        const safeTarget = await assertSafeUrl(url);
        const safeUrl = safeTarget.parsed || safeTarget;
        const lookup = safeTarget.address ? (hostname, options, callback) => {
            callback(null, safeTarget.address, safeTarget.family || net.isIP(safeTarget.address));
        } : undefined;
        const { data } = await axios.get(safeUrl.href, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 5000,
            maxRedirects: 0,
            maxContentLength: 2 * 1024 * 1024,
            maxBodyLength: 2 * 1024 * 1024,
            responseType: 'text',
            validateStatus: (status) => status >= 200 && status < 300,
            proxy: false,
            lookup
        });
        const $ = cheerio.load(data);

        const title =
            $('meta[property="og:title"]').attr('content') ||
            $('meta[name="twitter:title"]').attr('content') ||
            $('title').text() ||
            'No title found';

        const description =
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="twitter:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            'No description found';

        const thumbnail =
            $('meta[property="og:image"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content') ||
            '';

        let thumbnailUrl = '';
        if (thumbnail) {
            try {
                const parsedThumbnail = new URL(thumbnail, safeUrl);
                if (['http:', 'https:'].includes(parsedThumbnail.protocol) && !parsedThumbnail.username && !parsedThumbnail.password) {
                    const safeThumbnail = await assertSafeUrl(parsedThumbnail.href);
                    thumbnailUrl = (safeThumbnail.parsed || safeThumbnail).href;
                }
            } catch (error) {
                thumbnailUrl = '';
            }
        }

        return {
            title: limitText(title) || 'No title found',
            description: limitText(description) || 'No description found',
            thumbnail: limitText(thumbnailUrl),
            metadataStatus: 'complete'
        };
    } catch (error) {
        console.error(`Error fetching metadata for ${url}:`, error.message);
        return {
            title: 'Unable to fetch title',
            description: 'The site could not be reached or does not provide metadata.',
            thumbnail: '',
            metadataStatus: 'failed',
            metadataError: error.message.slice(0, 500)
        };
    }
}

module.exports = { fetchMetadata, assertSafeUrl, isPrivateAddress };
