/* ============================================================
   TOOLIFY — PDF Books (device-only 3D flipbook library)
   Books live only in this device's IndexedDB store. No cloud
   sync and no upload size limit. Pages are rendered lazily into
   high-resolution canvases, so a book opens immediately instead
   of waiting for every page to be converted first.
   ============================================================ */

const BOOK_PAGE_WIDTH = 600;
const BOOK_PAGE_HEIGHT = 800;
const BOOK_RENDER_RATIO = 2;

let bookItems = [];
let bookFlip = null;
let bookTotalPages = 0;
let bookZoom = 1;
let pdfDoc = null;
let currentBook = null;
let bookRenderToken = 0;
const bookRenderedPages = new Set();
const bookRenderingPages = new Set();

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
  if(input){ input.value = '1'; input.max = '1'; }
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
    // Purge any old full-document cache so the new lazy renderer is used.
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
  if(currentBook?.id === id) closeBookReader();
  bookItems = bookItems.filter(b => b.id !== id);
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
  const stage = document.getElementById('book-stage');
  if(!stage) return null;
  let element = document.getElementById('book');
  if(!element){
    // PageFlip.destroy() removes its container, so recreate it when needed.
    element = document.createElement('div');
    element.id = 'book';
    stage.appendChild(element);
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
  try{ bookFlip.turnToPage(page - 1); }catch(error){ console.warn(error); }
  preloadBookPages(page);
}

function applyBookZoom(){
  const stageBook = document.getElementById('book');
  const label = document.getElementById('book-zoom-label');
  if(stageBook) stageBook.style.transform = bookZoom === 1 ? '' : `scale(${bookZoom})`;
  if(label) label.textContent = Math.round(bookZoom * 100) + '%';
  const out = document.getElementById('book-zoom-out');
  const into = document.getElementById('book-zoom-in');
  if(out) out.disabled = bookZoom <= 0.6;
  if(into) into.disabled = bookZoom >= 1.8;
}

function changeBookZoom(delta){
  bookZoom = Math.max(0.6, Math.min(1.8, Math.round((bookZoom + delta) * 10) / 10));
  applyBookZoom();
}

function createBookPage(number){
  const div = document.createElement('div');
  div.className = 'page';
  div.dataset.page = number;
  const canvas = document.createElement('canvas');
  div.appendChild(canvas);
  return div;
}

async function renderBookPage(number){
  if(!pdfDoc || number < 1 || number > bookTotalPages) return;
  if(bookRenderedPages.has(number) || bookRenderingPages.has(number)) return;
  bookRenderingPages.add(number);
  const myToken = bookRenderToken;
  try{
    const page = await pdfDoc.getPage(number);
    if(myToken !== bookRenderToken) return;
    const original = page.getViewport({scale: 1});
    const scale = Math.min(BOOK_PAGE_WIDTH / original.width, BOOK_PAGE_HEIGHT / original.height);
    const viewport = page.getViewport({scale});
    const canvas = document.querySelector(`#book [data-page="${number}"] canvas`);
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = Math.round(viewport.width * BOOK_RENDER_RATIO);
    canvas.height = Math.round(viewport.height * BOOK_RENDER_RATIO);
    await page.render({
      canvasContext: ctx,
      viewport: page.getViewport({scale: scale * BOOK_RENDER_RATIO})
    }).promise;
    if(myToken === bookRenderToken) bookRenderedPages.add(number);
  }catch(error){
    console.warn('Book page render error:', number, error);
  }finally{
    bookRenderingPages.delete(number);
  }
}

function preloadBookPages(center){
  [center - 1, center, center + 1, center + 2].forEach(page => {
    if(page >= 1 && page <= bookTotalPages) renderBookPage(page);
  });
}

function createBookFlip(){
  const stageBook = ensureBookElement();
  if(!stageBook) return;
  stageBook.classList.remove('ready');
  stageBook.style.transform = '';
  bookFlip = new St.PageFlip(stageBook, {
    width: BOOK_PAGE_WIDTH,
    height: BOOK_PAGE_HEIGHT,
    size: 'stretch',
    minWidth: 250,
    maxWidth: 1000,
    minHeight: 350,
    maxHeight: 800,
    drawShadow: true,
    flippingTime: 700,
    usePortrait: false,
    startPage: 0,
    autoSize: true,
    maxShadowOpacity: 0.5,
    showCover: false,
    mobileScrollSupport: false
  });
  const pages = [];
  for(let i = 1; i <= bookTotalPages; i++) pages.push(createBookPage(i));
  bookFlip.loadFromHTML(pages);
  bookFlip.on('flip', (e) => {
    updateBookPageInfo();
    preloadBookPages(e.data + 1);
  });
  stageBook.classList.add('ready');
  updateBookPageInfo();
  applyBookZoom();
}

async function openBook(id){
  const book = bookItems.find(b => b.id === id);
  if(!book) return;
  const reader = document.getElementById('book-reader');
  if(!reader) return;

  const myToken = ++bookRenderToken;
  currentBook = book;
  reader.hidden = false;
  document.getElementById('book-reader-title').textContent = book.name;
  document.getElementById('book-reader-subtitle').textContent = bookFormatSize(book.size) + ' · lazy high-quality flipbook';

  if(bookFlip){ try{ bookFlip.destroy(); }catch(error){} bookFlip = null; }
  const stage = ensureBookElement();
  if(!stage) return;
  stage.classList.remove('ready');
  stage.innerHTML = '';
  stage.style.transform = '';
  pdfDoc = null;
  bookTotalPages = 0;
  bookZoom = 1;
  bookRenderedPages.clear();
  bookRenderingPages.clear();
  resetBookPageUI();
  applyBookZoom();
  setBookLoading('Opening your book…');

  try{
    if(!window.pdfjsLib || !window.St || !window.St.PageFlip){
      throw new Error('Flipbook libraries could not load. Check your connection and refresh.');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const buffer = await book.blob.arrayBuffer();
    if(myToken !== bookRenderToken) return;
    pdfDoc = await pdfjsLib.getDocument({data: new Uint8Array(buffer), isEvalSupported: false}).promise;
    if(myToken !== bookRenderToken) return;
    bookTotalPages = pdfDoc.numPages;
    const totalEl = document.getElementById('book-page-total');
    if(totalEl) totalEl.textContent = '/ ' + bookTotalPages;
    const pageInput = document.getElementById('book-page-input');
    if(pageInput) pageInput.max = String(bookTotalPages);

    createBookFlip();
    setBookLoading('', false);
    setControls(true);
    updateBookPageInfo();
    preloadBookPages(1);
    reader.scrollIntoView({behavior: 'smooth', block: 'start'});
  }catch(error){
    if(myToken !== bookRenderToken) return;
    console.error(error);
    setBookLoading(error?.message || 'Could not open this PDF.');
    booksStatus('Could not open ' + book.name + '.', true);
  }
}

function closeBookReader(){
  const reader = document.getElementById('book-reader');
  bookRenderToken++;
  if(bookFlip){ try{ bookFlip.destroy(); }catch(error){} bookFlip = null; }
  pdfDoc = null;
  currentBook = null;
  bookTotalPages = 0;
  bookRenderedPages.clear();
  bookRenderingPages.clear();
  const stage = document.getElementById('book');
  if(stage){ stage.classList.remove('ready'); stage.innerHTML = ''; }
  if(reader) reader.hidden = true;
  resetBookPageUI();
  setBookLoading('', false);
  setControls(false);
  if(document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function setControls(enabled){
  [
    'firstBtn', 'prevBtn', 'nextBtn', 'lastBtn',
    'book-prev', 'book-next', 'book-zoom-in', 'book-zoom-out'
  ].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.disabled = !enabled;
  });
  const input = document.getElementById('book-page-input');
  if(input) input.disabled = !enabled;
}

function toggleBookFullscreen(){
  const reader = document.getElementById('book-reader');
  if(!reader) return;
  if(!document.fullscreenElement){
    reader.requestFullscreen?.().catch(() => {});
  }else{
    document.exitFullscreen().catch(() => {});
  }
}

/* In fullscreen the PDF fills the page; chrome is revealed only when the
   cursor moves to the top (header) or bottom (footer) edge. */
let bookChromeTimer = null;
function showBookChrome(){
  const reader = document.getElementById('book-reader');
  if(!reader || !document.fullscreenElement) return;
  reader.classList.add('chrome-visible');
  clearTimeout(bookChromeTimer);
  bookChromeTimer = setTimeout(() => reader.classList.remove('chrome-visible'), 2200);
}

document.getElementById('book-reader')?.addEventListener('mousemove', (event) => {
  if(!document.fullscreenElement) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const nearTop = event.clientY - rect.top <= 90;
  const nearBottom = rect.bottom - event.clientY <= 80;
  if(nearTop || nearBottom) showBookChrome();
  else{
    const reader = event.currentTarget;
    reader.classList.remove('chrome-visible');
    clearTimeout(bookChromeTimer);
  }
});

document.addEventListener('fullscreenchange', () => {
  const reader = document.getElementById('book-reader');
  if(!reader) return;
  clearTimeout(bookChromeTimer);
  if(document.fullscreenElement === reader) showBookChrome();
  else reader.classList.remove('chrome-visible');
});

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

document.addEventListener('keydown', (event) => {
  const reader = document.getElementById('book-reader');
  if(!reader || reader.hidden) return;
  if(event.target === bookPageInput) return;
  if(event.key === 'Escape'){
    if(document.fullscreenElement){ document.exitFullscreen().catch(() => {}); }
    else closeBookReader();
  }else if(event.key === 'ArrowRight'){
    event.preventDefault(); bookFlip?.flipNext();
  }else if(event.key === 'ArrowLeft'){
    event.preventDefault(); bookFlip?.flipPrev();
  }else if((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')){
    event.preventDefault(); changeBookZoom(0.1);
  }else if((event.ctrlKey || event.metaKey) && event.key === '-'){
    event.preventDefault(); changeBookZoom(-0.1);
  }
});

setControls(false);
loadBooks();
