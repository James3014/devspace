const ARTIFACT_DOWNLOAD_PLATFORMS = new Set<NodeJS.Platform>(["linux"]);

export function isArtifactDownloadSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return ARTIFACT_DOWNLOAD_PLATFORMS.has(platform);
}
