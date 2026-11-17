// Upstream's connection storage, for the page's environment cache (`src/connection/platform.ts`,
// `pult/decisions`, `page-cache-store`): its layer builds every store upstream's web app keeps,
// of which the page takes the `EnvironmentCacheStore` alone.
export { layer as connectionStorageLayer } from "~/connection/storage";
