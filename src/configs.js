// Read configs from global variable if available, otherwise use the process.env injected from build.
const configs = {};

["BASE_ASSETS_PATH"].forEach(x => {
    const el = document.querySelector(`meta[name='env:${x.toLowerCase()}']`);
    configs[x] = el ? el.getAttribute("content") : process.env[x];

    if (x === "BASE_ASSETS_PATH" && configs[x]) {
        // eslint-disable-next-line no-undef
        __webpack_public_path__ = configs[x];
    }
});

export default configs;
