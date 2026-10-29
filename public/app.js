const $ = id => document.getElementById(id);

const state = {
  templates: [],
  sources: {},
  source: '',         // '' means query variables only
  template: null,
  values: {},         // field values by template, so switching back keeps edits
  dpr: '2',
  format: 'webp',
  objectUrl: null,
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
    showSample();
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
  showSample();
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
  const onInput = event => { field.values[field.name] = event.target.value; updateUrl(); };

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
  syncPreset();
  updateUrl();
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
  $(id).addEventListener('input', () => { syncPreset(); updateUrl(); });
}

for (const id of ['dpr', 'format']) {
  $(id).addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    state[id] = button.value;
    setPressed($(id), button.value);
    updateUrl();
  });
}

// The request

function normalizeParams(params) {
  // Forgive the usual paste mistakes: a URL without https://, a post URL as the slug
  if (params.url && !/^https?:\/\//i.test(params.url)) params.url = `https://${params.url}`;
  if (params.slug) params.slug = params.slug.replace(/\/+$/, '').split('/').pop();
  return params;
}

function buildPath() {
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

  const output = { width: $('width').value, height: $('height').value, dpr: state.dpr, format: state.format };
  for (const [name, value] of Object.entries(output)) {
    if (value !== API_DEFAULTS[name]) query.set(name, value);
  }

  const search = query.toString();
  return `/image/${encodeURIComponent(state.template.name)}${search ? `?${search}` : ''}`;
}

function updateUrl() {
  if (state.template) $('url').textContent = location.origin + buildPath();
}

function showSample() {
  clearResult();
  $('canvas').classList.add('is-sample');
  $('badge').hidden = false;
  const { width = 1200, height = 630 } = state.template;
  $('canvas').style.setProperty('--ratio', width / height);
  $('output').src = `/preview/${encodeURIComponent(state.template.name)}`;
  $('stats').textContent = state.source
    ? 'The example uses sample content. Enter your site to render it with yours.'
    : "The example uses the template's sample content. Render to see yours.";
}

function clearResult() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  $('download').hidden = true;
  $('error').hidden = true;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function render() {
  const missing = [...$('form').querySelectorAll('[required]')].find(input => !input.value.trim());
  if (missing) {
    $('error').textContent = `${missing.labels[0]?.firstChild.textContent ?? 'A field'} is required.`;
    $('error').hidden = false;
    return missing.focus();
  }

  const path = buildPath();
  const started = performance.now();
  $('render').disabled = true;
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
    state.objectUrl = URL.createObjectURL(blob);

    const image = $('output');
    image.src = state.objectUrl;
    await image.decode().catch(() => {});
    $('canvas').style.setProperty('--ratio', image.naturalWidth / image.naturalHeight);
    $('canvas').classList.remove('is-sample');
    $('badge').hidden = true;

    $('stats').textContent = [
      `${image.naturalWidth} × ${image.naturalHeight}`,
      state.format === 'jpeg' ? 'JPEG' : state.format === 'png' ? 'PNG' : 'WebP',
      formatBytes(blob.size),
      `${seconds} s`,
    ].join('  ·  ');

    const download = $('download');
    download.href = state.objectUrl;
    download.download = `${state.template.name}.${state.format === 'jpeg' ? 'jpg' : state.format}`;
    download.hidden = false;
    if (matchMedia('(max-width: 900px)').matches) $('canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
  } finally {
    $('render').disabled = false;
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

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('url').textContent);
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
});

// What this visitor has left of the server's hourly limit, if it has one

async function showAllowance() {
  const { rateLimit } = await fetch('/limits').then(response => response.json()).catch(() => ({}));
  if (!rateLimit) return;
  const minutes = Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 60000));
  $('allowance').textContent = rateLimit.remaining > 0
    ? `${rateLimit.remaining} of ${rateLimit.perHour} renders left this hour`
    : `No renders left; more in ${minutes} min`;
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
