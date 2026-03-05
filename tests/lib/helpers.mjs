export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}
