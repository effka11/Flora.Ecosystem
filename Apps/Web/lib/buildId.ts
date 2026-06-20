/** Set at build time (deploy.ps1). Used for CDN cache-bust query ?b= without panel purge. */
export function webBuildId(): string {
  return (process.env.NEXT_PUBLIC_BUILD_ID ?? "").trim();
}

export function loginPathWithBuildBust(): string {
  const id = webBuildId();
  return id ? `/login?b=${encodeURIComponent(id)}` : "/login";
}
