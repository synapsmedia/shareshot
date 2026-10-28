/**
 * Sources fill a template from somewhere else. A request names one with
 * `?source=<name>`; without one, the template gets the query string alone.
 *
 * Built-in templates read a common set of variables, so every template works
 * with every source:
 *
 *   title, description   the headline and a line or two below it
 *   image                a picture, e.g. a post's feature image
 *   logo, siteName, domain
 *                        who published it: a square icon, a name, a host name
 *   author, authorImage  who wrote it
 *   tag, date            a category, and a date already written out
 *   accent               a CSS colour
 *
 * A source fills in what it can; query variables override it, e.g. a shorter
 * title for a story.
 *
 * A source is an object with:
 *
 *   description   one line, listed at GET /sources
 *   params        { name: { label?, required?, secret?, description } }: the query
 *                 parameters it reads. They are not passed to the template, so
 *                 a key never ends up in the page.
 *   context(params, { fetch })
 *                 resolves to the variables it adds. `fetch` only reaches
 *                 public addresses; throw an HttpError for the caller's mistakes.
 *                 Besides the common variables, it may add its raw data for
 *                 templates made for it.
 *   variables     the common variables it can fill, so the playground knows
 *                 which ones are left to type
 *   templatesDir  optional: a directory with templates/, styles/ and assets/
 *                 for templates made for this source.
 */
const ghost = require('./ghost');

module.exports = { ghost };
