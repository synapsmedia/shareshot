const { HttpError } = require('../../core/errors');

/** A Ghost site's base URL, without the API path someone may have pasted. */
function normalizeGhostBaseUrl(input) {
  const urlWithProtocol = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  let url;
  try {
    url = new URL(urlWithProtocol);
  } catch {
    throw new HttpError(400, `"${input}" is not a URL`);
  }

  url.search = '';
  url.hash = '';
  url.pathname = url.pathname
    .replace(/\/ghost\/api\/(content|admin)\/?$/i, '')
    .replace(/\/+$/g, '');

  return url.toString().replace(/\/+$/g, '');
}

/** A Content API resource, `null` when Ghost answers 404. The key stays out of error messages. */
async function getContent(fetch, baseUrl, resource, key) {
  const response = await fetch(`${baseUrl}/ghost/api/content/${resource}${resource.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`);

  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(400, `${baseUrl} refused the Content API key`);
  }
  if (!response.ok) throw new HttpError(502, `${baseUrl} answered ${response.status} for ${resource.split('?')[0]}`);

  return response.json();
}

/** A date as the site would write it, in its own locale and timezone. */
function formatDate(value, { locale, timezone }) {
  if (!value) return undefined;
  const options = { dateStyle: 'medium', timeZone: timezone || 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale || 'en', options).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
  }
}

function hostname(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** The common variables (see sources/index.js) for the site, or for one of its posts. */
function commonVariables(site, post) {
  const shared = {
    logo: site.icon || site.logo,
    siteName: site.title,
    domain: hostname(site.url),
    accent: site.accent_color,
  };
  if (!post) {
    return { ...shared, title: site.title, description: site.description, image: site.cover_image };
  }

  const author = post.primary_author;
  return {
    ...shared,
    title: post.title,
    description: post.custom_excerpt || post.excerpt,
    image: post.feature_image,
    author: author?.name,
    authorImage: author?.profile_image,
    tag: post.primary_tag?.name,
    date: formatDate(post.published_at, site),
  };
}

/**
 * Ghost (https://ghost.org): the common variables from the site's Content
 * API, for the site itself or, with `slug`, one of its published posts. The
 * raw settings and post are there too, as `site` and `post`.
 */
module.exports = {
  description: 'Fills the template from a Ghost site, or with `slug` from one of its posts, through the Content API.',
  params: {
    url: { label: 'Site URL', required: true, description: "The site's URL, e.g. https://example.com or https://example.com/blog" },
    key: { label: 'Content API key', required: true, secret: true, description: 'Ghost Admin → Settings → Integrations' },
    slug: { label: 'Post slug', description: "A published post's slug, e.g. welcome. Without it, the site itself." },
  },
  variables: ['title', 'description', 'image', 'logo', 'siteName', 'domain', 'author', 'authorImage', 'tag', 'date', 'accent'],

  async context({ url, key, slug }, { fetch }) {
    const baseUrl = normalizeGhostBaseUrl(url);

    const settings = await getContent(fetch, baseUrl, 'settings/', key);
    if (!settings) throw new HttpError(400, `${baseUrl} doesn't look like a Ghost site`);
    const site = settings.settings;

    if (!slug) return { ...commonVariables(site), site };

    const posts = await getContent(fetch, baseUrl, `posts/slug/${encodeURIComponent(slug)}/?include=authors,tags`, key);
    if (!posts?.posts?.length) throw new HttpError(404, `No published post "${slug}" on ${baseUrl}`);
    const post = posts.posts[0];

    return { ...commonVariables(site, post), site, post };
  },
};

module.exports.normalizeGhostBaseUrl = normalizeGhostBaseUrl;
module.exports.commonVariables = commonVariables;
