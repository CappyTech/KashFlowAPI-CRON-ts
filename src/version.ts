// App version resolution (env overrides > package.json > 'dev').
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

export const APP_VERSION: string = (() => {
	if (process.env.APP_VERSION) return process.env.APP_VERSION;
	if (process.env.IMAGE_VERSION) return process.env.IMAGE_VERSION;
	try {
		const { version } = _require('../package.json');
		return version || 'dev';
	} catch { return 'dev'; }
})();
