document.addEventListener('DOMContentLoaded', () => {
    const linkForm = document.getElementById('link-form');
    const urlInput = document.getElementById('url-input');
    const tagsInput = document.getElementById('tags-input');
    const linksContainer = document.getElementById('links-container');
    const tagList = document.getElementById('tag-list');
    const sortSelect = document.getElementById('sort-select');
    const surpriseBtn = document.getElementById('surprise-btn');
    const surpriseModal = document.getElementById('surprise-modal');
    const surpriseContent = document.getElementById('surprise-content');
    const surpriseLink = document.getElementById('surprise-link');
    const closeSurprise = document.getElementById('close-surprise');

    let currentTag = null;
    let loadedLinks = [];
    let hasMoreLinks = false;
    let linksLoading = false;

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[character]));
    }

    function safeHttpUrl(value) {
        try {
            const parsed = new URL(String(value));
            const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
            const privateHost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
                hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80') ||
                /^127\./.test(hostname) || /^10\./.test(hostname) || /^169\.254\./.test(hostname) ||
                /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
            return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !privateHost
                ? parsed.href
                : '';
        } catch (error) {
            return '';
        }
    }

    async function requestJson(url, options) {
        const response = await fetch(url, options);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Request failed');
        return body;
    }

    async function fetchLinks({ append = false } = {}) {
        if (linksLoading || (append && !hasMoreLinks)) return;
        linksLoading = true;
        try {
            const sort = encodeURIComponent(sortSelect.value);
            const tag = encodeURIComponent(currentTag || '');
            const offset = append ? loadedLinks.length : 0;
            const response = await fetch(`/api/links?sort=${sort}&tag=${tag}&limit=100&offset=${offset}`);
            const links = await response.json();
            if (!response.ok) throw new Error(links.error || 'Request failed');
            loadedLinks = append ? loadedLinks.concat(links) : links;
            hasMoreLinks = response.headers.get('X-Has-More') === 'true';
            renderLinks(loadedLinks, hasMoreLinks);
        } catch (error) {
            linksContainer.innerHTML = `<p class="text-red-600">${escapeHtml(error.message)}</p>`;
        } finally {
            linksLoading = false;
        }
    }

    async function fetchTags() {
        try {
            renderTags(await requestJson('/api/tags'));
        } catch (error) {
            tagList.innerHTML = `<p class="text-red-600 text-sm">${escapeHtml(error.message)}</p>`;
        }
    }

    function renderLinks(links, showLoadMore = false) {
        if (links.length === 0) {
            linksContainer.innerHTML = `
                <div class="text-center py-20 text-slate-400">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 mx-auto mb-4 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5s3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18s-3.332.477-4.5 1.253" />
                    </svg>
                    <p class="text-lg">Your stash is empty. Time to find some cool links!</p>
                </div>
            `;
            return;
        }

        linksContainer.innerHTML = links.map(link => `
            <div class="link-card group bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all flex gap-4">
                ${safeHttpUrl(link.thumbnail) ? `
                    <div class="w-24 h-24 flex-shrink-0 rounded-lg overflow-hidden bg-slate-100">
                        <img src="${escapeHtml(safeHttpUrl(link.thumbnail))}" alt="${escapeHtml(link.title)}" class="w-full h-full object-cover" loading="lazy" referrerpolicy="no-referrer">
                    </div>
                ` : `
                    <div class="w-24 h-24 flex-shrink-0 rounded-lg bg-slate-100 flex items-center justify-center text-slate-300">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                    </div>
                `}
                <div class="flex-1 min-w-0">
                    <div class="flex items-start justify-between gap-2">
                         <a href="${escapeHtml(safeHttpUrl(link.url) || '#')}" target="_blank" rel="noopener noreferrer" class="text-lg font-bold text-slate-800 hover:text-indigo-600 transition-colors truncate">
                             ${escapeHtml(link.title || 'Untitled Link')}
                        </a>
                         <button type="button" data-delete-link="${escapeHtml(link.id)}" class="delete-btn opacity-0 text-slate-400 hover:text-red-500 transition-all">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5-4h4m-4 0a1 1 0 00-1 1v1h2V4a1 1 0 00-1-1z" />
                            </svg>
                        </button>
                    </div>
                     <p class="text-slate-500 text-sm line-clamp-2 mb-3">${escapeHtml(link.description || 'No description available.')}</p>
                    <div class="flex items-center justify-between">
                        <div class="flex flex-wrap gap-2">
                             ${link.tags ? link.tags.split(',').map(tag => `
                                 <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full font-medium">#${escapeHtml(tag)}</span>
                            `).join('') : ''}
                        </div>
                        <label class="flex items-center gap-2 cursor-pointer text-xs font-medium ${link.is_read ? 'text-indigo-600' : 'text-slate-400'}">
                             <input type="checkbox" ${link.is_read ? 'checked' : ''}
                                 data-toggle-read="${escapeHtml(link.id)}"
                                 class="rounded text-indigo-600 focus:ring-indigo-500">
                            ${link.is_read ? 'Read' : 'Mark as read'}
                        </label>
                    </div>
                </div>
            </div>
        `).join('') + (showLoadMore ? `
            <button type="button" data-load-more class="mx-auto mt-2 rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200">
                Load more links
            </button>
        ` : '');
    }

    function renderTags(tags) {
        tagList.innerHTML = `
             <button type="button" data-filter-tag="" class="px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${!currentTag ? 'bg-indigo-100 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'} text-left">
                All Links
            </button>
        ` + tags.map(tag => `
             <button type="button" data-filter-tag="${escapeHtml(tag)}" class="px-3 py-1.5 rounded-lg text-sm font-medium transition-all text-left ${currentTag === tag ? 'bg-indigo-100 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}">
                #${escapeHtml(tag)}
            </button>
        `).join('');
    }

    async function filterTag(tag) {
        currentTag = tag;
        await fetchLinks();
        await fetchTags();
    }

    async function toggleRead(id, is_read) {
        try {
            await requestJson(`/api/links/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_read })
            });
            await fetchLinks();
        } catch (error) {
            alert(error.message);
        }
    }

    async function deleteLink(id) {
        if (!confirm('Delete this link?')) return;
        try {
            await requestJson(`/api/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
            await fetchLinks();
            await fetchTags();
        } catch (error) {
            alert(error.message);
        }
    }

    tagList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-filter-tag]');
        if (button) filterTag(button.dataset.filterTag || null);
    });

    linksContainer.addEventListener('click', (event) => {
        const button = event.target.closest('[data-delete-link]');
        if (button) deleteLink(button.dataset.deleteLink);
        if (event.target.closest('[data-load-more]')) fetchLinks({ append: true });
    });

    linksContainer.addEventListener('change', (event) => {
        const checkbox = event.target.closest('[data-toggle-read]');
        if (checkbox) toggleRead(checkbox.dataset.toggleRead, checkbox.checked);
    });

    linkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = urlInput.value;
        const tags = tagsInput.value.split(',').map(t => t.trim()).filter(t => t);

        try {
            await requestJson('/api/links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, tags })
            });
            urlInput.value = '';
            tagsInput.value = '';
            await fetchLinks();
            await fetchTags();
        } catch (error) {
            alert(error.message);
        }
    });

    sortSelect.addEventListener('change', fetchLinks);

    surpriseBtn.addEventListener('click', async () => {
        let link;
        try {
            link = await requestJson('/api/links/random');
        } catch (error) {
            alert(error.message);
            return;
        }

        surpriseContent.innerHTML = `
            <div class="text-center">
                <div class="text-indigo-600 font-bold uppercase tracking-widest text-xs mb-2">Surprise Link!</div>
                <h3 class="text-2xl font-bold text-slate-800 mb-4">${escapeHtml(link.title || 'Untitled Link')}</h3>
                 ${safeHttpUrl(link.thumbnail) ? `
                     <img src="${escapeHtml(safeHttpUrl(link.thumbnail))}" class="w-full h-48 object-cover rounded-xl mb-4 shadow-md" referrerpolicy="no-referrer">
                ` : ''}
                <p class="text-slate-500 text-sm italic">${escapeHtml(link.description || 'No description available.')}</p>
            </div>
        `;
        surpriseLink.href = safeHttpUrl(link.url) || '#';
        surpriseLink.rel = 'noopener noreferrer';
        surpriseModal.classList.remove('hidden');
    });

    closeSurprise.addEventListener('click', () => {
        surpriseModal.classList.add('hidden');
    });

    // Initial Load
    fetchLinks();
    fetchTags();
});
