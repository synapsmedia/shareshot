const handlebars = require('handlebars');
const hljs = require('highlight.js/lib/common');
const { format } = require('date-fns');

/** Highlighting a longer snippet costs time, and an image shows only a screenful anyway. */
const MAX_CODE_LENGTH = 4000;

/** Hex, a colour name, or rgb()/hsl() with numbers only. */
const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([\d\s.,%/+-]+\))$/i;

function registerHelpers() {
  // Variables inside <style> need more than HTML escaping, which lets `;` and
  // `}` through: {{cssColor color "#0A7CF6"}} gives the colour, or the fallback.
  handlebars.registerHelper('cssColor', function(value, fallback) {
    const color = typeof value === 'string' ? value.trim() : '';
    if (CSS_COLOR.test(color)) return color;
    return typeof fallback === 'string' ? fallback : '';
  });

  // {{highlight code language}}: the code as HTML, its tokens in <span class="hljs-…">.
  // highlight.js escapes the code itself; without a known language it is only escaped.
  handlebars.registerHelper('highlight', function(code, language) {
    const text = typeof code === 'string' ? code.slice(0, MAX_CODE_LENGTH) : '';
    const name = typeof language === 'string' ? language.trim().toLowerCase() : '';
    if (name && hljs.getLanguage(name)) {
      return new handlebars.SafeString(hljs.highlight(text, { language: name, ignoreIllegals: true }).value);
    }
    return new handlebars.SafeString(handlebars.escapeExpression(text));
  });

  handlebars.registerHelper('formatDate', function(date, formatString) {
    if (!date) return '';
    try {
      const dateObj = typeof date === 'string' ? new Date(date) : date;
      return format(dateObj, formatString || 'MMM dd, yyyy');
    } catch (error) {
      console.error('Date formatting error:', error);
      return date;
    }
  });
}

module.exports = { registerHelpers };
