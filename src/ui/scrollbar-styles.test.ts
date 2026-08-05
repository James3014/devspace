import assert from "node:assert/strict";
import { PIERRE_SCROLLBAR_STYLES } from "./scrollbar-styles.js";

assert.match(PIERRE_SCROLLBAR_STYLES, /\[data-code\]::-webkit-scrollbar/);
assert.match(PIERRE_SCROLLBAR_STYLES, /scrollbar-gutter:\s*auto/);
assert.match(PIERRE_SCROLLBAR_STYLES, /background-color:\s*var\(--scrollbar-thumb/);
assert.doesNotMatch(PIERRE_SCROLLBAR_STYLES, /scrollbar-(?:width|color)/);
assert.doesNotMatch(PIERRE_SCROLLBAR_STYLES, /100 116 139|71 85 105/);
