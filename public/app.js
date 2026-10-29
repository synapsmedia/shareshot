const $ = id => document.getElementById(id);

const state = {
  templates: [],
  sources: {},
  source: '',         // '' means query variables only
  template: null,
  values: {},         // field values by template, so switching back keeps edits
  dpr: '2',
  format: 'webp',
  image: null,        // the rendered image, { url, ratio, stats }, until anything changes
  mode: 'preview',    // what the stage shows: 'preview', 'sample' or 'image'
};

const SIZE_PRESETS = ['1200x630', '1080x1080', '1080x1350', '1080x1920'];
const API_DEFAULTS = { width: '1200', height: '630', dpr: '2', format: 'webp' };

if (/Mac|iPhone|iPad/.test(navigator.platform)) $('shortcut').textContent = '⌘ ↵';

function humanize(name) {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setPressed(group, value) {
  for (const button of group.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.value === value));
  }
}

// Data source

const ICONS = {
  text: '<path d="M3 4h10M8 4v9"/>',
  source: '<path d="M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

function renderSources() {
  const options = [['', 'Text', 'text'], ...Object.keys(state.sources).map(name => [name, humanize(name), 'source'])];
  // Browsers without customizable selects drop the icon and keep the label
  $('sources').append(...options.map(([value, label, iconName]) =>
    element('option', { value }, [icon(iconName), element('span', { textContent: label })])));
  $('sources').addEventListener('change', event => selectSource(event.target.value));
}

function selectSource(source) {
  state.source = source;
  $('sources').value = source;
  const hint = source ? state.sources[source].description : 'Fill the template with your own text.';
  // `name` in a description reads as code
  $('sourceHint').replaceChildren(...hint.split('`').map((part, index) =>
    index % 2 ? element('code', { textContent: part }) : part));
  if (state.template) {
    renderFields();
    updatePreview();
  }
}

// Templates: every one works with every source

function renderGallery() {
  $('gallery').replaceChildren(...state.templates.map(t => element('button', {
    type: 'button',
    className: (t.height ?? 630) > (t.width ?? 1200) ? 'template is-upright' : 'template',
    value: t.name,
    title: t.description ?? '',
  }, [
    element('span', { className: 'thumb' }, [
      element('img', { src: `/preview/${encodeURIComponent(t.name)}`, alt: '', loading: 'lazy' }),
    ]),
    element('span', { className: 'name', textContent: t.title ?? humanize(t.name) }),
  ])));
}

$('gallery').addEventListener('click', event => {
  const button = event.target.closest('.template');
  if (button) selectTemplate(button.value);
});

function selectTemplate(name) {
  state.template = state.templates.find(t => t.name === name);
  for (const button of $('gallery').querySelectorAll('.template')) {
    button.setAttribute('aria-pressed', String(button.value === name));
  }

  const { width = 1200, height = 630 } = state.template;
  setSize(width, height);
  renderFields();
  updatePreview();
}

// Fields: the template's variables. With a source, its parameters come
// first, then the variables it doesn't fill, then the ones it does, to override.
// Values are kept per source and template, so switching back keeps edits.

function templateFields(values, withExamples) {
  return Object.entries(state.template.fields ?? {}).map(([name, example]) => ({
    name,
    label: humanize(name),
    values,
    value: withExamples ? String(example) : '',
    placeholder: withExamples ? '' : String(example),
    optional: !withExamples,
  }));
}

function fieldGroups() {
  if (!state.source) {
    return { main: templateFields(state.values[`|${state.template.name}`] ??= {}, true), extra: [], overrides: [] };
  }

  const source = state.sources[state.source];
  const sourceValues = state.values[state.source] ??= {};
  const filled = new Set(source.variables ?? []);
  const fields = templateFields(state.values[`${state.source}|${state.template.name}`] ??= {}, false);
  return {
    main: Object.entries(source.params).map(([name, param]) => ({
      name,
      label: param.label ?? humanize(name),
      hint: param.description,
      required: !!param.required,
      optional: !param.required,
      sourceParam: true,
      values: sourceValues,
      value: '',
      placeholder: name === 'url' ? 'https://example.com' : '',
    })),
    extra: fields.filter(field => !filled.has(field.name)),
    overrides: fields
      .filter(field => filled.has(field.name))
      .map(field => ({ ...field, placeholder: `From ${humanize(state.source)}`, optional: false })),
  };
}

function allFields() {
  const { main, extra, overrides } = fieldGroups();
  return [...main, ...extra, ...overrides];
}

function fieldControl(field) {
  const value = field.values[field.name] ?? field.value;
  const id = `field-${field.name}`;
  const onInput = event => {
    field.values[field.name] = event.target.value;
    updateUrl();
    leaveImage();
    // A source fetches the site, so wait until a URL looks typed
    schedulePreview(field.sourceParam ? 800 : 300);
  };

  let control;
  if (field.name === 'accent' || /^#[0-9a-f]{6}$/i.test(value)) {
    const text = element('input', { id, type: 'text', value, placeholder: field.placeholder, spellcheck: false });
    const picker = element('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000', tabIndex: -1 });
    picker.setAttribute('aria-label', `${field.label} picker`);
    picker.addEventListener('input', event => { text.value = event.target.value; onInput(event); });
    text.addEventListener('input', event => {
      if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value;
      onInput(event);
    });
    control = element('div', { className: 'color-input' }, [picker, text]);
  } else if (field.name === 'code') {
    control = element('textarea', { id, rows: 8, value, placeholder: field.placeholder, spellcheck: false, className: 'code' });
    control.addEventListener('input', onInput);
  } else if (['description', 'quote'].includes(field.name) || (value.length > 60 && !/^https?:\/\//.test(value))) {
    control = element('textarea', { id, rows: 2, value, placeholder: field.placeholder });
    control.addEventListener('input', onInput);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(field.values[field.name] ?? (field.value || field.placeholder))) {
    control = element('input', { id, type: 'date', value });
    control.addEventListener('input', onInput);
  } else {
    control = element('input', {
      id,
      type: 'text',
      value,
      required: !!field.required,
      spellcheck: false,
      autocomplete: 'off',
      placeholder: field.placeholder,
    });
    control.addEventListener('input', onInput);
  }

  // Image fields take a URL; say so, since an example may be left empty
  const hint = field.hint ?? (/^(image|logo|authorImage)$/.test(field.name) ? 'A public image URL, https://…' : '');

  const label = element('label', { htmlFor: id, textContent: field.label });
  if (field.optional) label.append(' ', element('span', { className: 'optional', textContent: 'optional' }));

  return element('div', { className: 'field' }, [
    label,
    control,
    ...(hint ? [element('p', { className: 'hint', textContent: hint })] : []),
  ]);
}

function renderFields() {
  const { main, extra, overrides } = fieldGroups();
  const nodes = [...main, ...extra].map(fieldControl);

  if (overrides.length) {
    const sourceName = humanize(state.source);
    nodes.push(element('details', {
      className: 'overrides',
      open: overrides.some(field => field.values[field.name]),
    }, [
      element('summary', { textContent: `Override what ${sourceName} fills in` }),
      ...overrides.map(fieldControl),
    ]));
  }

  $('fields').replaceChildren(...(nodes.length ? nodes : [element('p', { className: 'hint', textContent: 'This template takes no variables.' })]));
  updateUrl();
}

// Size and format

function setSize(width, height) {
  $('width').value = width;
  $('height').value = height;
  sizeChanged();
}

/** A new size needs no new page: the preview's frames just take it. */
function sizeChanged() {
  syncPreset();
  updateUrl();
  leaveImage();
  fitFrames();
}

function syncPreset() {
  const size = `${$('width').value}x${$('height').value}`;
  $('preset').value = SIZE_PRESETS.includes(size) ? size : 'custom';
}

$('preset').addEventListener('change', event => {
  if (event.target.value === 'custom') return $('width').focus();
  const [width, height] = event.target.value.split('x');
  setSize(width, height);
});

for (const id of ['width', 'height']) {
  $(id).addEventListener('input', sizeChanged);
}

for (const id of ['dpr', 'format']) {
  $(id).addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    state[id] = button.value;
    setPressed($(id), button.value);
    updateUrl();
    leaveImage();
  });
}

// The request

function normalizeParams(params) {
  // Forgive the usual paste mistakes: a URL without https://, a post URL as the slug
  if (params.url && !/^https?:\/\//i.test(params.url)) params.url = `https://${params.url}`;
  if (params.slug) params.slug = params.slug.replace(/\/+$/, '').split('/').pop();
  return params;
}

/** The image's URL path, or with `page`, the template page's that the live preview shows. */
function buildPath({ page = false } = {}) {
  const query = new URLSearchParams();
  if (state.source) query.set('source', state.source);

  const params = {};
  for (const field of allFields()) {
    const value = (field.values[field.name] ?? field.value).trim();
    if (value) params[field.name] = value;
  }
  for (const [name, value] of Object.entries(state.source ? normalizeParams(params) : params)) {
    query.set(name, value);
  }

  if (!page) {
    const output = { width: $('width').value, height: $('height').value, dpr: state.dpr, format: state.format };
    for (const [name, value] of Object.entries(output)) {
      if (value !== API_DEFAULTS[name]) query.set(name, value);
    }
  }

  const search = query.toString();
  return `/${page ? 'template' : 'image'}/${encodeURIComponent(state.template.name)}${search ? `?${search}` : ''}`;
}

function updateUrl() {
  if (state.template) $('url').textContent = location.origin + buildPath();
}

// The stage: a live preview of the template as a page, drawn by this browser;
// with a source but no site yet, the template's example image; after Render,
// the image itself.

function outputSize() {
  const clamp = value => Math.min(4096, Math.max(1, Math.round(Number(value)) || 1));
  return { width: clamp($('width').value), height: clamp($('height').value) };
}

function showMode(mode) {
  state.mode = mode;
  $('frame').hidden = mode !== 'preview';
  $('output').hidden = mode === 'preview';
  setPressed($('view'), mode === 'image' ? 'image' : 'preview');
  $('view').querySelector('[value="preview"]').textContent = mode === 'sample' ? 'Example' : 'Live preview';

  if (mode === 'image') {
    $('output').src = state.image.url;
    $('canvas').style.setProperty('--ratio', state.image.ratio);
    $('stats').textContent = state.image.stats;
  } else if (mode === 'sample') {
    const { width = 1200, height = 630 } = state.template;
    $('canvas').style.setProperty('--ratio', width / height);
    $('output').src = `/preview/${encodeURIComponent(state.template.name)}`;
    $('stats').textContent = 'The example uses sample content. Enter your site to see it with yours.';
  } else {
    fitFrames();
  }
}

/** Gives the frames the image's size and scales them down to the stage. */
function fitFrames() {
  if (state.mode !== 'preview') return;
  const { width, height } = outputSize();
  $('canvas').style.setProperty('--ratio', width / height);
  for (const frame of $('frame').querySelectorAll('iframe')) {
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
  }
  $('frame').style.setProperty('--scale', $('frame').clientWidth / width);
  $('stats').textContent = `${width} × ${height}  ·  A live preview in your browser; render to get the image`;
}

new ResizeObserver(fitFrames).observe($('frame'));

/** Anything that changes drops the rendered image, which no longer matches, and shows the preview. */
function leaveImage() {
  clearResult();
  if (state.mode === 'image') showPreview();
}

function showPreview() {
  showMode(missingField() ? 'sample' : 'preview');
}

// The switch: the rendered image is kept until something changes, so switching
// back to it doesn't render again
$('view').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.getAttribute('aria-pressed') === 'true') return;
  if (button.value === 'preview') showPreview();
  else if (state.image) showMode('image');
  else render();
});

function missingField() {
  return [...$('form').querySelectorAll('[required]')].find(input => !input.value.trim());
}

const preview = { timer: null, request: 0 };

function schedulePreview(delay) {
  clearTimeout(preview.timer);
  preview.timer = setTimeout(updatePreview, delay);
}

/**
 * Loads the template page with the form's values into the hidden frame and
 * shows it once it has loaded, so the preview never flashes blank. Only the
 * latest change's page is shown.
 */
async function updatePreview() {
  clearTimeout(preview.timer);
  if (!state.template) return;
  const request = ++preview.request;

  if (missingField()) {
    if (state.mode !== 'image') showMode('sample');
    return;
  }

  try {
    const response = await fetch(buildPath({ page: true }));
    const html = await response.text();
    if (request !== preview.request) return;
    if (!response.ok) {
      let message = `The server answered ${response.status}`;
      try { message = JSON.parse(html).error || message; } catch {}
      throw new Error(message);
    }

    const frames = [...$('frame').querySelectorAll('iframe')];
    const shown = frames.find(frame => !frame.hidden);
    const hidden = frames.find(frame => frame.hidden);
    await new Promise(resolve => {
      hidden.onload = resolve;
      hidden.srcdoc = html;
    });
    if (request !== preview.request) return;
    hidden.hidden = false;
    shown.hidden = true;
    if (state.mode !== 'image') {
      $('error').hidden = true;
      showMode('preview');
    }
  } catch (error) {
    if (request !== preview.request || state.mode === 'image') return;
    $('error').textContent = error.message;
    $('error').hidden = false;
  }
}

function clearResult() {
  if (state.image) URL.revokeObjectURL(state.image.url);
  state.image = null;
  $('error').hidden = true;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Renders the image and shows it; resolves to whether that worked. */
function setBusy(busy) {
  for (const button of [$('render'), $('download'), $('view').querySelector('[value="image"]')]) button.disabled = busy;
}

async function loadImage(url) {
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => {});
  return image;
}

async function render() {
  const missing = missingField();
  if (missing) {
    $('error').textContent = `${missing.labels[0]?.firstChild.textContent ?? 'A field'} is required.`;
    $('error').hidden = false;
    missing.focus();
    return false;
  }

  const path = buildPath();
  const started = performance.now();
  setBusy(true);
  $('error').hidden = true;
  $('canvas').classList.add('is-busy');

  try {
    const response = await fetch(path);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `The server answered ${response.status}`);
    }

    const blob = await response.blob();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    clearResult();
    const url = URL.createObjectURL(blob);
    const { naturalWidth: width, naturalHeight: height } = await loadImage(url);
    state.image = {
      url,
      ratio: width / height,
      stats: [
        `${width} × ${height}`,
        state.format === 'jpeg' ? 'JPEG' : state.format === 'png' ? 'PNG' : 'WebP',
        formatBytes(blob.size),
        `${seconds} s`,
      ].join('  ·  '),
    };
    showMode('image');

    if (matchMedia('(max-width: 900px)').matches) $('canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    return false;
  } finally {
    setBusy(false);
    $('canvas').classList.remove('is-busy');
    showAllowance();
  }
}

$('form').addEventListener('submit', event => {
  event.preventDefault();
  render();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    render();
  }
});

// Saves the image shown, or renders it first from the preview. Any change
// leaves the image, so the one shown always matches the form.
$('download').addEventListener('click', async () => {
  if (!state.image && !(await render())) return;
  const extension = state.format === 'jpeg' ? 'jpg' : state.format;
  element('a', { href: state.image.url, download: `${state.template.name}.${extension}` }).click();
});

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('url').textContent);
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
});

// What this visitor has left of the server's image limits, if it has any: the
// window that is used up, or else the one with the least left of those an
// hour or longer (a minute's allowance is no news to someone clicking Render)

const HOUR = 60 * 60 * 1000;
const WINDOW_MS = { second: 1000, minute: 60 * 1000, hour: HOUR, day: 24 * HOUR };

function waitText(time) {
  const seconds = Math.max(1, Math.ceil((time - Date.now()) / 1000));
  return seconds < 60 ? `${seconds} s` : seconds < 2 * 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds / 3600)} h`;
}

async function showAllowance() {
  const { rateLimits } = await fetch('/limits').then(response => response.json()).catch(() => ({}));
  const windows = rateLimits?.images ?? [];
  if (!windows.length) return;

  const full = windows.filter(window => window.remaining === 0).sort((a, b) => b.resetAt - a.resetAt)[0];
  const long = windows.filter(window => WINDOW_MS[window.per] >= HOUR);
  const shown = (long.length ? long : windows).reduce((least, window) => (window.remaining < least.remaining ? window : least));
  $('allowance').textContent = full
    ? `No renders left; more in ${waitText(full.resetAt)}`
    : `${shown.remaining} of ${shown.limit} renders left ${shown.per === 'day' ? 'today' : `this ${shown.per}`}`;
  $('allowance').hidden = false;
}

// Start

async function start() {
  const [templates, sources, info] = await Promise.all(
    ['/templates', '/sources', '/info'].map(path => fetch(path).then(response => response.json())));

  state.templates = templates;
  state.sources = sources;

  for (const link of document.querySelectorAll('.repo-link')) {
    link.href = info.repository + link.dataset.path;
  }
  $('version').textContent = `Shareshot ${info.version}`;
  if (info.operator) {
    $('operatorLink').textContent = info.operator.name;
    if (info.operator.url) $('operatorLink').href = info.operator.url;
    $('operator').hidden = false;
  }

  renderSources();
  renderGallery();
  showAllowance();
  selectSource('');
  const first = state.templates.find(t => t.name === 'split') ?? state.templates[0];
  if (first) selectTemplate(first.name);
}

start().catch(error => {
  $('error').textContent = `Couldn't load the templates: ${error.message}`;
  $('error').hidden = false;
});
