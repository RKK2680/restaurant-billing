class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (m) => new HttpError(400, m);
const unauthorized = (m = 'Please sign in') => new HttpError(401, m);
const forbidden = (m = 'You do not have permission to do this') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
