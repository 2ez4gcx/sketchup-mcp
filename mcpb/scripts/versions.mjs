// Checks that the places holding the version match: package.json, manifest.json, main.rb (VERSION), su_mcp.rb (ext.version)
// and, when given, package-lock.json.
export function checkVersions(pkgVersion, manifestVersion, mainRb, loaderRb, lockVersion) {
  const main = /VERSION\s*=\s*'([^']+)'/.exec(mainRb);
  const loader = /ext\.version\s*=\s*'([^']+)'/.exec(loaderRb);
  const found = {
    'package.json': pkgVersion,
    'manifest.json': manifestVersion,
    'extension/su_mcp/main.rb (VERSION)': main ? main[1] : null,
    'extension/su_mcp.rb (ext.version)': loader ? loader[1] : null,
    ...(lockVersion === undefined ? {} : { 'package-lock.json': lockVersion }),
  };
  const bad = Object.entries(found).filter(([, v]) => v !== pkgVersion);
  if (bad.length) {
    const list = Object.entries(found).map(([k, v]) => `  ${k}: ${v ?? '(not found)'}`).join('\n');
    throw new Error(`Version mismatch, all must be ${pkgVersion}:\n${list}`);
  }
  return pkgVersion;
}
