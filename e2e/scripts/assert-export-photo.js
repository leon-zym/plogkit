/* global EXPORT_INDEX, PLOGKIT_EXPORT_ASSERTION_URL, http */

const response = http.post(PLOGKIT_EXPORT_ASSERTION_URL + "/" + EXPORT_INDEX, { body: "" });

if (!response.ok) {
  throw new Error(response.body || "The system photo assertion failed.");
}
