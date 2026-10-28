# Shareshot

Open Graph and social media images (link previews, posts, stories) rendered on the fly from HTML templates.

A template is a Handlebars page with its CSS and assets. Shareshot fills it with the request's variables, renders it in Chromium and returns a WebP, PNG or JPEG of any size. **Sources** fill a template from somewhere else: `?source=ghost` fetches a Ghost site and one of its posts, so any template can show the post's title, author and feature image.

## Features

- WebP, PNG or JPEG from Handlebars templates, at any size and pixel ratio
- A playground with template thumbnails and the request URL for every image
- Template previews as HTML
- Thirteen built-in templates that fit any size, from 1200 × 630 to a 1080 × 1920 story
- Sources that fill any template; Ghost is built in
- Your own templates, fonts and images, mounted without a fork
- A Docker image on GitHub Container Registry
- Can be imported as a library, to add your own sources

## Quick Start

```bash
docker compose up
```

The service runs at `http://localhost:3000`, with a playground at `/`.

```bash
# An Open Graph image from query variables
curl "http://localhost:3000/image/article?title=Hello%20World&description=Rendered%20from%20HTML" > og.webp

# The same template as a 1080×1920 story, as PNG
curl "http://localhost:3000/image/article?title=Hello&width=1080&height=1920&dpr=1&format=png" > story.png

# A Ghost post's image, with a shorter title than the post's
curl "http://localhost:3000/image/split?source=ghost&url=https://example.com&key=CONTENT_API_KEY&slug=my-post&title=Short" > post.webp
```

## API

### Generate an image

```http
GET /image/{template}?width&height&dpr&format&source&…
```

| Parameter | Default | |
|---|---|---|
| `template` | | Template name, without `.hbs` |
| `width`, `height` | `1200`, `630` | Viewport size in CSS pixels, at most 4096 |
| `dpr` | `2` | Device pixel ratio, 0.5 to 3; the image is `width × dpr` pixels wide |
| `format` | `webp` | `webp`, `png` or `jpeg` |
| `source` | none | A [source](#sources) that fills the template |

Every other parameter is passed to the template as a variable, except the source's own parameters. A variable in the query wins over the source's.

### Preview a template

```http
GET /template/{template}?source&…
```

The same page as HTML, with the same variables.

### List templates and sources

```http
GET /templates
GET /preview/{template}
GET /sources
```

`/templates` lists each template with its [metadata](#template-metadata). `/preview/{template}` is its thumbnail as WebP, rendered once from the template's example values. `/sources` lists each source's description, parameters and the [common variables](#common-variables) it fills. The playground at `/` is built on these.

### Health check

```http
GET /health
```

Answers `{"status":"ok"}`. `GET /info` answers the version, the repository and the [operator](#configuration).

Errors come back as JSON, `{"error": "…"}`: 400 for a bad parameter, 404 for an unknown template or post, 502 when a source's site fails.

## Sources

A source fills a template from somewhere else. Without `source`, a template gets the query string alone.

### Common variables

The built-in templates read the same variable names, and sources fill them, so every template works with every source:

| Variable | |
|---|---|
| `title`, `description` | The headline, and a line or two below it |
| `image` | A picture, e.g. a post's feature image |
| `logo`, `siteName`, `domain` | Who published it: a square icon, a name, a host name |
| `author`, `authorImage` | Who wrote it |
| `tag`, `date` | A category, and a date already written out |
| `accent` | A CSS colour |

A query variable overrides what the source filled in, e.g. a shorter `title` for a story. Templates may take variables of their own too, such as `badge` in `announcement`, which come from the query.

### `ghost`

Fills the common variables from a Ghost site's [Content API](https://ghost.org/docs/content-api/): with `slug` from one of its published posts, without it from the site itself.

| Parameter | |
|---|---|
| `url` | The site's URL, e.g. `https://example.com` or `https://example.com/blog` |
| `key` | A Content API key (Ghost Admin → Settings → Integrations) |
| `slug` | A published post's slug (optional) |

| Variable | From the post | From the site (no `slug`) |
|---|---|---|
| `title` | title | site title |
| `description` | custom excerpt, or excerpt | site description |
| `image` | feature image | cover image |
| `author`, `authorImage` | primary author's name and profile image | |
| `tag` | primary tag | |
| `date` | published date, in the site's locale and timezone | |
| `logo`, `siteName`, `domain`, `accent` | the site's icon (or logo), title, host and accent colour | the same |

The raw settings and post are there as well, as `site` and `post` (with `authors` and `tags`), for templates made for Ghost:

```hbs
<h1>{{post.title}}</h1>
<p>{{post.primary_author.name}} · {{formatDate post.published_at "MMM d, yyyy"}}</p>
<footer>{{site.title}}</footer>
```

### Writing a source

A source is an object; `src/sources/ghost/index.js` is an example:

```js
module.exports = {
  description: 'One line, listed at /sources',
  params: {
    url: { required: true, description: '…' },
  },
  // The common variables it can fill, so the playground knows which are left to type
  variables: ['title', 'description', 'image'],
  async context({ url }, { fetch }) {
    // `fetch` reaches public addresses only; throw HttpError(400, '…') for bad input
    const page = await (await fetch(url)).json();
    return { title: page.name, description: page.summary, image: page.cover, page };
  },
  templatesDir: __dirname, // optional: templates/, styles/ and assets/ made for this source
};
```

Add it to `src/sources/index.js`, or keep it in your own code and run Shareshot as a library:

```js
const { createApp, initBrowser, sources } = require('shareshot');

initBrowser().then(() => {
  createApp({ sources: { ...sources, mine: require('./my-source') } }).listen(3000);
});
```

The app is a plain Express app, so you can add middleware in front of it, such as authentication or rate limits.

## Templates

A template is `templates/{name}.hbs`. Its stylesheet, `styles/{name}.css` (or the one named by the `style` parameter), is inlined where the template puts `{{{styleTag}}}`. Names may only contain letters, digits, `-` and `_`.

The built-in ones read the [common variables](#common-variables) and fit any size: they scale with the image, and stack when it is upright.

| Template | | Its own variables |
|---|---|---|
| `article` | Tag, headline and summary on a dark card, with the byline and site | |
| `split` | Image on one half, the story on the other | |
| `feature` | Headline and byline over a full-bleed image | |
| `centered` | Logo, headline and summary centred on the accent colour | |
| `minimal` | Large condensed type on white, framed in the accent colour | |
| `quote` | A pull quote with its author | `quote` (otherwise `description`) |
| `announcement` | A badge, headline and date, for releases and news | `badge`, e.g. `New` or `v2.0` |
| `newsletter` | A masthead with the issue, and a serif headline | `issue`, e.g. `Issue 42` |
| `story` | Made for 1080 × 1920: image, headline and a "Read on …" button | `callToAction` replaces "Read on {domain}" |
| `event` | A date block with the title, time and place | `eventDate` as `2026-11-14`, `time`, `location` |
| `stat` | One big number and what it counts | `value`, e.g. `12,400`, and `label` |
| `podcast` | Cover art, episode and title, with a waveform | `episode`, `duration` |
| `code` | A highlighted snippet in a window; `title` is its file name | `code`, `language` (any [highlight.js](https://highlightjs.org) common language) |

Their example values use images from synapsmedia.com, so the playground thumbnails need the server to reach the internet.

### Template metadata

An optional `templates/{name}.json` next to the template tells the playground how to show it:

```json
{
  "title": "Article",
  "description": "Tag, headline and summary on a dark card, with the byline and site",
  "fields": { "title": "What we learned shipping our first public API", "author": "Ada Lindqvist" }
}
```

| Key | |
|---|---|
| `title`, `description` | How the template is listed |
| `fields` | The variables it takes, each with an example value; its thumbnail is rendered with them |
| `width`, `height` | The size it is designed for, when it isn't 1200 × 630 |

### Variables in CSS

`{{…}}` escapes HTML, not CSS. A variable inside `<style>` or a `style` attribute could close the rule and add its own, so pass colours through `cssColor`, which returns the value only if it is a colour, otherwise the fallback:

```hbs
<style>:root { --accent: {{cssColor accent "#0A7CF6"}}; }</style>
```

Two more helpers: `{{formatDate eventDate "MMM d"}}` formats a date with [date-fns](https://date-fns.org/docs/format), and `{{highlight code language}}` returns the code as HTML with its tokens in `<span class="hljs-…">`, escaped by highlight.js.

### Your own templates

Mount a directory with the same layout and point `TEMPLATES_DIR` at it (several, comma separated). Its templates are found before the sources' and the built-in ones:

```
my-templates/
  templates/release.hbs
  styles/release.css
  assets/brand.woff2
```

Files in `assets/` are served at `/template-assets/`. Images are rendered as pages of this server, so a stylesheet can load them with relative URLs:

```css
@font-face { font-family: Brand; src: url(/template-assets/brand.woff2); }
```

An SVG exported from a design tool makes a good template: inline it in the `.hbs` and replace the text that changes with a variable, e.g. `<text …>{{version}}</text>`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `TEMPLATES_DIR` | none | Extra template directories, comma separated, searched first |
| `MAX_CONCURRENT_RENDERS` | `4` | Pages rendered at the same time; further requests wait |
| `ALLOW_PRIVATE_NETWORKS` | off | `1` lets pages and sources reach private, loopback and link-local addresses |
| `OPERATOR_NAME`, `OPERATOR_URL` | none | Who runs this instance, credited as "Provided by" in the playground |

Variables are HTML-escaped with `{{…}}`, so a query parameter can't add markup or scripts. Rendered pages also carry a Content Security Policy that allows only scripts from this server, i.e. those a template ships in its `assets/`. Keep `{{{…}}}` for HTML a template builds itself. The `style` parameter takes a stylesheet name, never a URL.

Template variables end up in the page, and sources fetch the URLs they are given. So rendered pages may only load from public addresses (and from this server), and sources may only fetch public addresses, each redirect checked again. Without that, anyone who can request an image could make the server reach internal URLs.

## Docker

```bash
docker run --rm -p 3000:3000 ghcr.io/synapsmedia/shareshot:latest
```

Build it locally:

```bash
docker build -t shareshot .
docker run --rm -p 3000:3000 shareshot
```

The workflow in `.github/workflows/docker.yml` builds the image on pull requests and publishes it to `ghcr.io/synapsmedia/shareshot`: `latest` from the default branch, and a version tag for each `v*.*.*` Git tag.

## Development

```bash
docker compose -f docker-compose-dev.yml up --build
```

This mounts `src/`, `templates/`, `styles/` and `public/` and restarts on changes. Without Docker, with Node.js and a Chromium that Puppeteer can use:

```bash
npm install
npm run dev
```

## License

MIT
