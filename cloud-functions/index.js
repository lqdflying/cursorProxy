// EdgeOne Pages Cloud Function: redirect root path to GitHub repository.

export function onRequest() {
  return Response.redirect("https://github.com/lqdflying/cursorProxy", 302);
}
