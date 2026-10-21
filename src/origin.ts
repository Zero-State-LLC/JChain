// Cookie-authenticated human writes send Sec-Fetch-Site or Origin.
// Bearer credentials and upload tokens never reach this check.
export function sameOrigin(request: Request, siteOrigin: string): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  return request.headers.get("origin") === siteOrigin;
}
