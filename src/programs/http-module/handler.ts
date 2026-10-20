/**
 * The handler of the server.
 *
 * This file is a *module*: it exports functions and runs nothing. The module
 * is compiled on its own — by the C backend or by the machine backend, as the
 * project names — and the program that starts the server links it beside
 * itself. The handler is therefore the same code whichever backend built it,
 * and the answers it gives are the answers the server gives.
 *
 * The request and the response are the runtime's own, and they are borrowed:
 * they are there for as long as the request is being served.
 */
export function handler(req: any, res: any): void {
	const path = http.requestPath(req);
	if (path === `/health`) {
		http.responseStatus(res, 200);
		http.responseHeader(res, `Content-Type`, `application/json`);
		http.responseEnd(res, `{"status":"ok"}`);
	} else if (path === `/echo`) {
		/* The echo of what was posted, as JSON. The body of the request is
		   read as text, and the answer is built around it. */
		const body = http.requestBody(req);
		http.responseStatus(res, 200);
		http.responseHeader(res, `Content-Type`, `application/json`);
		http.responseEnd(res, `{"echo":${body}}`);
	} else {
		http.responseStatus(res, 404);
		http.responseHeader(res, `Content-Type`, `application/json`);
		http.responseEnd(res, `{"error":"not found"}`);
	}
}
