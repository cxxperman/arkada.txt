// Entry point for Millennium's own compiler (starlight, see millennium.toml). starlight wants an ES module
// with a default export; the plugin itself is plain CommonJS so that Node can run it in the tests as it is.
import entry from './index.js';

export default entry.default;
