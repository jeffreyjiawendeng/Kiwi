export interface AboutInfo {
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  installType: "installed" | "portable" | "development";
  protocolVersion: string;
  buildIdentifier: string;
  signed: boolean;
}

export interface AboutSources {
  appVersion: string;
  protocolVersion: string;
  versions: { electron: string; chrome: string; node: string };
  platform: string;
  arch: string;
  isPackaged: boolean;
  appPath: string;
  env: NodeJS.ProcessEnv;
}

export function detectInstallType(sources: AboutSources): AboutInfo["installType"] {
  if (!sources.isPackaged) return "development";
  // electron-builder sets this for the portable target only.
  if (sources.env["PORTABLE_EXECUTABLE_DIR"] !== undefined) return "portable";
  return "installed";
}

export function buildAboutInfo(sources: AboutSources): AboutInfo {
  return {
    appVersion: sources.appVersion,
    electronVersion: sources.versions.electron,
    chromiumVersion: sources.versions.chrome,
    nodeVersion: sources.versions.node,
    platform: sources.platform,
    architecture: sources.arch,
    installType: detectInstallType(sources),
    protocolVersion: sources.protocolVersion,
    buildIdentifier: sources.env["KIWI_BUILD_ID"] ?? "local",
    // An unverified build is never presented as official. Builds are not code signed, so this
    // stays false; an operator who signs theirs changes it here and in scripts/manifest.mjs.
    signed: false,
  };
}
