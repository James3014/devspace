/**
 * Pierre renders its actual code scrollers in a shadow root. Keep this CSS
 * separate from the document utility so it can be injected through Pierre's
 * supported unsafeCSS option.
 */
export const PIERRE_SCROLLBAR_STYLES = `
[data-code] {
  scrollbar-gutter: auto;
  padding-bottom: var(--diffs-gap-block, var(--diffs-gap-fallback));
}

[data-code]::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

[data-code]::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}

[data-code]::-webkit-scrollbar-track {
  background: transparent;
}

[data-code]::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb, rgb(156 156 156 / 58%));
  background-clip: content-box;
  border: 2px solid transparent;
  border-radius: 9999px;
}

[data-code]:is(:hover, :focus, :focus-within)::-webkit-scrollbar-thumb,
:host(:is(:hover, :focus, :focus-within)) [data-code]::-webkit-scrollbar-thumb,
[data-code]::-webkit-scrollbar-thumb:hover {
  background-color: var(--scrollbar-thumb-hover, rgb(204 204 204 / 82%));
}

[data-code]::-webkit-scrollbar-corner {
  background: transparent;
}
`;
