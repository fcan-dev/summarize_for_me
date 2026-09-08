# Third-party components

This extension vendors the following third-party libraries under `vendor/` so
it works fully offline (no CDN).

| File | Library | Version | License | Source |
|------|---------|---------|---------|--------|
| `vendor/Readability.js` | [Mozilla Readability](https://github.com/mozilla/readability) | 0.5.0 | Apache-2.0 | https://github.com/mozilla/readability/blob/main/LICENSE |
| `vendor/DOMPurify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.1.6 | Apache-2.0 and MPL-2.0 | https://github.com/cure53/DOMPurify/blob/main/LICENSE |
| `vendor/marked.min.js` | [marked](https://github.com/markedjs/marked) | 12.0.2 | MIT | https://github.com/markedjs/marked/blob/main/LICENSE.md |

The bundled project code (everything outside `vendor/`) is licensed under the
[MIT License](LICENSE).
