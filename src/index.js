export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("Oura Worker OK", {
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store"
        }
      });
    }

    return env.ASSETS.fetch(request);
  }
};
