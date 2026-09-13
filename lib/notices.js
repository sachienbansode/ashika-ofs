'use strict';
/**
 * Standing wording that has to be identical wherever it appears.
 *
 * A bid accepted by this application is not a bid accepted by the exchange. It sits
 * in the book until the desk builds the file and uploads it, and the exchange blocks
 * margin at THAT moment, against whatever the client has then — not against the
 * margin this app checked when the bid was typed. A client whose margin falls in
 * between has a bid that this screen said was fine and the exchange refuses, and the
 * only defence against "but your system accepted it" is to have said so at the time,
 * in the same words, on every screen and in every confirmation.
 *
 * So the sentence lives here, the API returns it with every accepted bid, and the
 * front ends print what the server sent. Their hard-coded fallbacks are checked
 * against this file by a test, because a fallback that drifts is the copy that ends
 * up in front of the client.
 */

/** Shown on a successful place or modify, on all three logins. */
const BID_ACCEPTED =
  'This bid is recorded with the OFS desk. It is subject to the margin available ' +
  'at the time the bid is submitted to the exchange, and to acceptance by the ' +
  'exchange.';

/** The same fact, in the second person, for a client's own confirmation email. */
const BID_ACCEPTED_EMAIL =
  'Your bid has been recorded with the OFS desk. It remains subject to the margin ' +
  'available at the time the bid is submitted to the exchange, and to acceptance ' +
  'by the exchange.';

module.exports = { BID_ACCEPTED, BID_ACCEPTED_EMAIL };
