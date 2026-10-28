const handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');
const { HttpError } = require('./errors');

/**
 * Template directories, searched in order: those in TEMPLATES_DIR (comma
 * separated), then the sources' own, then the built-in one. Each has the same
 * layout:
 *
 *   templates/<name>.hbs   the page
 *   templates/<name>.json  optional: how the playground lists it (see listTemplates)
 *   styles/<name>.css      its styles, inlined as {{{styleTag}}}
 *   assets/                fonts and images, served at /template-assets/
 *
 * so a template can be added by mounting a directory, without forking.
 */
const BUILT_IN_DIR = path.join(__dirname, '../..');
const configuredDirs = (process.env.TEMPLATES_DIR || '').split(',').map(dir => dir.trim()).filter(Boolean).map(dir => path.resolve(dir));
const sourceDirs = [];

function templateDirs() {
  return [...configuredDirs, ...sourceDirs, BUILT_IN_DIR];
}

/** Adds a source's template directory, searched after TEMPLATES_DIR and before the built-in one. */
function addSourceTemplateDir(dir) {
  if (!sourceDirs.includes(dir)) sourceDirs.push(dir);
}

/** Template and style names are file names, never paths. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

async function findFile(subdir, name, extension) {
  if (!NAME_PATTERN.test(name)) throw new HttpError(404, `Invalid name "${name}"`);

  for (const dir of templateDirs()) {
    const file = path.join(dir, subdir, `${name}.${extension}`);
    if (await fs.access(file).then(() => true, () => false)) return file;
  }
  throw new HttpError(404, `No ${subdir.replace(/s$/, '')} named "${name}"`);
}

async function readMetadata(dir, name) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'templates', `${name}.json`), 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`templates/${name}.json: ${error.message}`);
  }
}

/**
 * Every template, with its metadata from templates/<name>.json:
 *
 *   title, description   how the playground lists it
 *   fields               its variables, each with the example value its
 *                        thumbnail is rendered with
 *   width, height        the size it is designed for (default: 1200×630)
 *
 * A name found in several directories is the first one's, as in findFile.
 */
async function listTemplates() {
  const templates = new Map();
  for (const dir of templateDirs()) {
    const files = await fs.readdir(path.join(dir, 'templates')).catch(() => []);
    for (const file of files) {
      const name = path.basename(file, '.hbs');
      if (!file.endsWith('.hbs') || !NAME_PATTERN.test(name) || templates.has(name)) continue;
      templates.set(name, { name, ...(await readMetadata(dir, name)) });
    }
  }
  return [...templates.values()];
}

async function renderTemplate(templateName, variables, baseUrl) {
  const templateContent = await fs.readFile(await findFile('templates', templateName, 'hbs'), 'utf-8');
  const template = handlebars.compile(templateContent);

  // `style` picks another of the server's stylesheets, never a URL: a remote
  // stylesheet would let anyone restyle the image into whatever they like.
  const cssContent = await fs.readFile(await findFile('styles', variables.style || templateName, 'css'), 'utf-8');
  const styleTag = `<style>${cssContent}</style>`;

  const enrichedVariables = {
    ...variables,
    baseUrl,
    styleTag
  };

  return template(enrichedVariables);
}

module.exports = { renderTemplate, listTemplates, templateDirs, addSourceTemplateDir };
