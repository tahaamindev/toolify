/* ============================================================
   TOOLIFY — PDF Books (device-only 3D flipbook library)
   Books live only in this device's IndexedDB store. No cloud
   sync, no upload size limit. Rendered pages are cached on this
   device, so a PDF is rendered only the very first time it opens.
   ============================================================ */

const BOOK_RENDER_SCALE = 3;
const BOOK_RENDER_QUALITY = 0.95;
let bookItems = [];
let bookFlip = null;
let bookTotalPages = 0;
let bookZoom = 1;
let bookBaseWidth = 450;
let bookBaseHeight = 600;
const bookImageCache = new Map();

function booksStatus(message, isError = false){
  const el = document.getElementById('books-status');
  if(!el) return;
  el.textContent = message || '';
  el.classList.toggle('error', !!isError);
}

function bookFormatSize(bytes){
  const value = Number(bytes) || 0;
  if(value < 1024) return value + ' B';
  if(value < 1024 * 1024) return (value / 1024).toFixed(0) + ' KB';
  if(value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
  return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function setBookLoading(message, show = true){
  const el = document.getElementById('book-loading');
  if(!el) return;
  el.textContent = message || '';
  el.hidden = !show;
}

function resetBookPageUI(){
  const input = document.getElementById('book-page-input');
  const total = document.getElementById('book-page-total');
  const bar = document.getElementById('book-progress-bar');
  if(input) input.value = '1';
  if(total) total.textContent = '/ 0';
  if(bar) bar.style.width = '0%';
}

async function loadBooks(){
  try{
    const local = await DB.getAllBooks();
    bookItems = local.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    renderBooks();
  }catch(error){
    console.warn('Could not load books:', error);
    booksStatus('Could not load your books.', true);
  }
}

function renderBooks(){
  const list = document.getElementById('books-list');
  if(!list) return;
  const count = document.getElementById('books-count');
  if(count) count.textContent = bookItems.length;
  if(!bookItems.length){
    list.innerHTML = '<div class="books-empty">No books yet.<br>Add a PDF to build your library.</div>';
    return;
  }
  list.innerHTML = bookItems.map(book => `
    <div class="book-item" data-book-id="${book.id}" role="button" tabindex="0" aria-label="Open ${escapeHTML(book.name)}">
      <div class="book-item-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M12 6.3c-1.9-1.3-4.2-1.8-7.2-1.7v13c3-.1 5.3.4 7.2 1.7 1.9-1.3 4.2-1.8 7.2-1.7v-13c-3-.1-5.3.4-7.2 1.7Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 6.3v13" stroke="currentColor" stroke-width="1.7"/></svg>
      </div>
      <div class="book-item-meta">
        <div class="book-item-name">${escapeHTML(book.name)}</div>
        <div class="book-item-sub">${book.pageCount ? book.pageCount + ' pages &middot; ' : ''}${bookFormatSize(book.size)}</div>
      </div>
      <button class="book-item-delete" type="button" data-book-delete="${book.id}" title="Remove book" aria-label="Remove ${escapeHTML(book.name)}">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`).join('');
}

async function handleBookUpload(file){
  if(!file) return;
  if(file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)){
    booksStatus('Please choose a valid PDF file.', true);
    return;
  }
  booksStatus('Saving ' + file.name + '…');
  try{
    const buffer = await file.arrayBuffer();
    const record = {
      id: 'bk_' + uid(),
      name: file.name.replace(/\.pdf$/i, ''),
      size: file.size,
      pageCount: 0,
      createdAt: new Date().toISOString(),
      blob: new Blob([buffer], {type: 'application/pdf'})
    };
    await DB.putBook(record);
    bookImageCache.delete(record.id);
    await DB.delBookPages(record.id).catch(() => {});
    bookItems.unshift(record);
    renderBooks();
    booksStatus('Saved on this device.');
    toast('PDF added to your books');
  }catch(error){
    console.error(error);
    booksStatus('Could not save this PDF.', true);
    toast('Could not save PDF', 'error');
  }
}

async function removeBook(id){
  const book = bookItems.find(b => b.id === id);
  if(!book) return;
  bookItems = bookItems.filter(b => b.id !== id);
  bookImageCache.delete(id);
  renderBooks();
  try{
    await DB.delBook(id);
    await DB.delBookPages(id);
    toast('Book removed');
  }catch(error){
    console.error(error);
    toast('Could not remove book', 'error');
  }
}

function confirmRemoveBook(id){
  const book = bookItems.find(b => b.id === id);
  if(!book) return;
  document.getElementById('confirm-title').textContent = 'Remove this book?';
  document.getElementById('confirm-msg').textContent = `"${book.name}" will be removed from this device.`;
  document.getElementById('confirm-overlay').classList.add('open');
  document.getElementById('confirm-ok').onclick = async () => {
    await removeBook(id);
    document.getElementById('confirm-overlay').classList.remove('open');
    document.getElementById('confirm-ok').onclick = doDeleteTool;
  };
}

function ensureBookElement(){
  const viewport = document.getElementById('book-zoom-viewport');
  if(!viewport) return null;
  let element = document.getElementById('book');
  if(!element){
    element = document.createElement('div');
    element.id = 'book';
    viewport.appendChild(element);
  }
  return element;
}

function updateBookPageInfo(){
  if(!bookFlip) return;
  const index = bookFlip.getCurrentPageIndex();
  const input = document.getElementById('book-page-input');
  const total = document.getElementById('book-page-total');
  const bar = document.getElementById('book-progress-bar');
  if(input) input.value = String(index + 1);
  if(total) total.textContent = '/ ' + bookTotalPages;
  if(bar) bar.style.width = (bookTotalPages ? ((index + 1) / bookTotalPages) * 100 : 0) + '%';
}

function jumpToBookPage(rawValue){
  if(!bookFlip) return;
  const input = document.getElementById('book-page-input');
  let page = parseInt(rawValue, 10);
  if(!Number.isFinite(page)) page = parseInt(input?.value, 10);
  if(!Number.isFinite(page)) page = 1;
  page = Math.max(1, Math.min(bookTotalPages || 1, page));
  if(input) input.value = String(page);
  try{ bookFlip.flip(page - 1); }catch(error){ console.warn(error); }
}

function sizeZoomViewport(){
  const viewport = document.getElementById('book-zoom-viewport');
  if(!viewport) return;
  // PageFlip draws two pages side by side, so the canvas needs double page width.
  viewport.style.width = Math.round(bookBaseWidth * 2 * bookZoom) + 'px';
  viewport.style.height = Math.round(bookBaseHeight * bookZoom) + 'px';
}

function applyBookZoom(){
  const viewport = document.getElementById('book-zoom-viewport');
  const stageBook = document.getElementById('book');
  const label = document.getElementById('book-zoom-label');
  if(!viewport || !stageBook) return;
  if(bookZoom === 1){
    stageBook.style.transformOrigin = '';
    stageBook.style.transform = '';
  }else{
    stageBook.style.transformOrigin = 'top left';
    stageBook.style.transform = 'scale(' + bookZoom + ')';
  }
  sizeZoomViewport();
  if(label) label.textContent = Math.round(bookZoom * 100) + '%';
  const out = document.getElementById('book-zoom-out');
  const into = document.getElementById('book-zoom-in');
  if(out) out.disabled = bookZoom <= 0.5;
  if(into) into.disabled = bookZoom >= 2;
}

function changeBookZoom(delta){
  bookZoom = Math.max(0.5, Math.min(2, Math.round((bookZoom + delta) * 10) / 10));
  applyBookZoom();
}

function calculateBookSize(){
  const stage = document.getElementById('book-stage');
  const isMobile = window.innerWidth < 700;
  const availW = Math.max(240, (stage?.clientWidth || 700) - 36);
  const availH = Math.max(320, (stage?.clientHeight || 600) - 36);
  const ratio = 0.75;
  const maxW = isMobile ? 320 : 440;
  const maxH = isMobile ? 440 : 590;
  let w = Math.min(maxW, isMobile ? availW * 0.92 : availW / 2, availH * ratio);
  let h = w / ratio;
  if(h > maxH){ h = maxH; w = h * ratio; }
  bookBaseWidth = Math.round(w);
  bookBaseHeight = Math.round(h);
}

function createBookFlip(images){
  calculateBookSize();
  const stageBook = ensureBookElement();
  if(stageBook){
    stageBook.style.cssText = '';
    // PageFlip's canvas is 100% of this element — it must have a real size.
    stageBook.style.width = (bookBaseWidth * 2) + 'px';
    stageBook.style.height = bookBaseHeight + 'px';
  }
  sizeZoomViewport();
  bookFlip = new St.PageFlip(stageBook, {
    width: bookBaseWidth,
    height: bookBaseHeight,
    size: 'stretch',
    minWidth: 240,
    maxWidth: 1200,
    minHeight: 300,
    maxHeight: 1400,
    maxShadowOpacity: 0.6,
    showCover: true,
    mobileScrollSupport: true,
    usePortrait: true,
    startPage: 0,
    drawShadow: true,
    flippingTime: 700,
    autoSize: false,
    clickEventForward: true,
    useMouseEvents: true,
    swipeDistance: 30,
    showPageCorners: true
  });
  bookFlip.loadFromImages(images);
  bookFlip.on('flip', updateBookPageInfo);
  bookTotalPages = images.length;
  updateBookPageInfo();
  applyBookZoom();
}

async function renderBookPages(book){
  const bar = document.getElementById('book-progress-bar');
  setBookLoading('Rendering pages at full quality…');
  const pdf = await pdfjsLib.getDocument({data: new Uint8Array(await book.blob.arrayBuffer()), isEvalSupported: false}).promise;
  const total = pdf.numPages;
  const images = [];
  for(let pageNumber = 1; pageNumber <= total; pageNumber++){
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({scale: BOOK_RENDER_SCALE});
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
    images.push(canvas.toDataURL('image/jpeg', BOOK_RENDER_QUALITY));
    page.cleanup();
    if(bar) bar.style.width = ((pageNumber / total) * 100) + '%';
  }
  const rendered = {pageCount: total, images};
  bookImageCache.set(book.id, rendered);
  // Persist once so a reload never re-renders the same PDF again.
  await DB.putBookPages({
    id: book.id, name: book.name, size: book.size, pageCount: total,
    images, scale: BOOK_RENDER_SCALE, createdAt: new Date().toISOString()
  }).catch(error => console.warn('Book page cache not saved:', error));
  if(book.pageCount !== total){
    book.pageCount = total;
    await DB.putBook(book).catch(() => {});
    renderBooks();
  }
  return rendered;
}

async function openBook(id){
  const book = bookItems.find(b => b.id === id);
  if(!book) return;
  const overlay = document.getElementById('book-overlay');
  if(!overlay) return;
  document.getElementById('book-reader-title').textContent = book.name;
  document.getElementById('book-reader-subtitle').textContent = bookFormatSize(book.size) + ' · 3D flipbook';
  overlay.classList.add('open');
  // PageFlip.destroy() removes its container, so recreate #book before each open.
  if(bookFlip){ try{ bookFlip.destroy(); }catch(error){} bookFlip = null; }
  const stage = ensureBookElement();
  if(!stage) return;
  stage.innerHTML = '';
  bookTotalPages = 0;
  resetBookPageUI();
  setBookLoading('Opening your book…');
  try{
    if(!window.pdfjsLib || !window.St || !window.St.PageFlip){
      throw new Error('Flipbook libraries could not load. Check your connection and refresh.');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    let rendered = bookImageCache.get(book.id);
    if(!rendered){
      const saved = await DB.getBookPages(book.id).catch(() => null);
      if(saved && saved.size === book.size && saved.name === book.name && Array.isArray(saved.images) && saved.images.length){
        rendered = {pageCount: saved.pageCount || saved.images.length, images: saved.images};
        bookImageCache.set(book.id, rendered);
      }
    }
    if(!rendered){
      rendered = await renderBookPages(book);
    }else{
      const bar = document.getElementById('book-progress-bar');
      if(bar) bar.style.width = '100%';
    }
    createBookFlip(rendered.images);
    setBookLoading('', false);
  }catch(error){
    console.error(error);
    setBookLoading(error?.message || 'Could not open this PDF.');
    booksStatus('Could not open ' + book.name + '.', true);
  }
}

function closeBookReader(){
  const overlay = document.getElementById('book-overlay');
  if(!overlay) return;
  overlay.classList.remove('open');
  if(bookFlip){ try{ bookFlip.destroy(); }catch(error){} bookFlip = null; }
  const stage = document.getElementById('book');
  if(stage) stage.innerHTML = '';
  if(document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function toggleBookFullscreen(){
  const reader = document.querySelector('.book-reader');
  if(!reader) return;
  if(!document.fullscreenElement){
    reader.requestFullscreen?.().catch(() => {});
  }else{
    document.exitFullscreen().catch(() => {});
  }
}

document.getElementById('books-add-btn')?.addEventListener('click', () => {
  document.getElementById('book-file-input')?.click();
});
document.querySelector('[data-right-panel="books"]')?.addEventListener('click', () => loadBooks());
document.getElementById('book-file-input')?.addEventListener('change', async (event) => {
  await handleBookUpload(event.target.files[0]);
  event.target.value = '';
});
const booksListEl = document.getElementById('books-list');
booksListEl?.addEventListener('click', (event) => {
  const removeButton = event.target.closest('[data-book-delete]');
  if(removeButton){ event.stopPropagation(); confirmRemoveBook(removeButton.dataset.bookDelete); return; }
  const item = event.target.closest('[data-book-id]');
  if(item) openBook(item.dataset.bookId);
});
booksListEl?.addEventListener('keydown', (event) => {
  if(event.key !== 'Enter' && event.key !== ' ') return;
  const item = event.target.closest('[data-book-id]');
  if(item){ event.preventDefault(); openBook(item.dataset.bookId); }
});
document.getElementById('book-close')?.addEventListener('click', closeBookReader);
document.getElementById('book-prev')?.addEventListener('click', () => bookFlip?.flipPrev());
document.getElementById('book-next')?.addEventListener('click', () => bookFlip?.flipNext());
document.getElementById('book-fullscreen-btn')?.addEventListener('click', toggleBookFullscreen);
document.getElementById('book-fullscreen-footer')?.addEventListener('click', toggleBookFullscreen);
document.getElementById('book-zoom-in')?.addEventListener('click', () => changeBookZoom(0.1));
document.getElementById('book-zoom-out')?.addEventListener('click', () => changeBookZoom(-0.1));
const bookPageInput = document.getElementById('book-page-input');
bookPageInput?.addEventListener('change', () => jumpToBookPage(bookPageInput.value));
bookPageInput?.addEventListener('keydown', (event) => {
  if(event.key === 'Enter'){ event.preventDefault(); jumpToBookPage(bookPageInput.value); bookPageInput.blur(); }
});
document.getElementById('book-overlay')?.addEventListener('click', (event) => {
  if(event.target.id === 'book-overlay') closeBookReader();
});
document.addEventListener('keydown', (event) => {
  if(!document.getElementById('book-overlay')?.classList.contains('open')) return;
  if(event.target === bookPageInput) return;
  if(event.key === 'Escape'){ closeBookReader(); }
  else if(event.key === 'ArrowRight'){ event.preventDefault(); bookFlip?.flipNext(); }
  else if(event.key === 'ArrowLeft'){ event.preventDefault(); bookFlip?.flipPrev(); }
  else if((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')){ event.preventDefault(); changeBookZoom(0.1); }
  else if((event.ctrlKey || event.metaKey) && event.key === '-'){ event.preventDefault(); changeBookZoom(-0.1); }
});

loadBooks();
