'use strict';
/**
 * The OFS bidding rules, in one place, for both front ends.
 *
 * Every statement here is traceable to a source, and the source is shown beside it —
 * SEBI's framework, BSE Notice 20150122-30, or NSE's OFS WEB API Protocol v1.3.0.
 * A rule with no citation is a rule nobody can check, and this page is read by
 * clients deciding what to bid.
 *
 * Where the two exchanges genuinely differ, they differ here too. The temptation is
 * to write one "OFS rules" page and gloss the differences; that is exactly how a
 * retail cut-off bid ends up with a floor price at NSE, where it must be blank.
 *
 * `window.OFS_RULES` is read by both public/client and public/backoffice.
 */
window.OFS_RULES = {
  updated: '2 September 2026',

  /* ---- what is the same at both exchanges ---- */
  common: [
    { h: 'Two categories, two days',
      p: 'Non-Retail — institutional and HNI — bid on T day. Retail bid on T+1. Each has its own '
       + 'window on its own day, and a category is closed outside it.',
      src: 'SEBI CIR/MRD/DP/32/2014' },
    { h: 'Floor price — and it may not be published',
      p: 'The floor is the lowest price the seller will accept. Disclosing it is the seller\'s '
       + 'choice: it is given to the designated exchange after trading closes on T-1, and only '
       + 'published if the seller chooses to. When it is not published, bids are placed without it '
       + 'and the exchange applies the floor when it matches — so a bid below the floor is rejected '
       + 'at the exchange rather than on this screen.',
      src: 'NSE e-OFS FAQ v3.0 Q12 · BSE 20150122-30 §1.4' },
    { h: 'Cut-off price',
      p: 'Retail investors may bid at cut-off instead of naming a price. The cut-off is derived from '
       + 'the Non-Retail bids received on T day, so it is not known when a retail bid is placed.',
      src: 'SEBI CIR/MRD/DP/32/2014' },
    { h: 'Retail cap — ₹2 lakh',
      p: 'A retail application is capped at ₹2,00,000. Above that the bid belongs in the Non-Retail '
       + '(NII) category, and forfeits any retail discount.',
      src: 'SEBI framework · BSE 20150122-30 §4.3.5' },
    { h: 'Retail reservation',
      p: 'At least 10% of the offer is reserved for retail investors.',
      src: 'SEBI framework' },
    { h: 'Discount',
      p: 'The seller may offer retail investors a discount, on the cut-off price or the bid price. '
       + 'A retail investor bidding in the NII category is not eligible for it.',
      src: 'BSE 20150122-30 §4.3.5' },
    { h: 'One live bid per scrip',
      p: 'A client holds one live bid per scrip. A second is a modification of the first, not a new bid.',
      src: 'Ashika desk rule' },
    { h: 'Quantity and price steps',
      p: 'Quantity must be a multiple of the market lot; price must be a multiple of the tick size.',
      src: 'BSE 20150122-30 Annexure 1' },
    { h: 'When bids may be placed',
      p: 'Within normal trading hours, on the day of the offer, and never beyond one trading day. '
       + 'Ashika applies its own cut-off, which is earlier than the market close and is shown on '
       + 'the bidding screen.',
      src: 'BSE 20150122-30 §4.1.1' },
    { h: 'The offer can be withdrawn',
      p: 'The seller may withdraw the offer at any time before it opens. Once it has opened it '
       + 'runs to its close.',
      src: 'NSE e-OFS FAQ v3.0 Q14' },
    { h: 'How shares are allotted',
      p: 'The designated exchange allots on the basis the seller declared in advance — either '
       + 'price-time priority or proportionate. Which one applies is part of the offer '
       + 'announcement, a day before the OFS.',
      src: 'NSE e-OFS FAQ v3.0 Q6, Q13' },
    { h: 'If the market halts',
      p: 'A market-wide circuit breaker halts the offer for sale as well.',
      src: 'BSE 20150122-30 §4.1.2' }
  ],

  /* ---- where they differ, and it is not cosmetic ---- */
  exchanges: {
    NSE: {
      label: 'NSE — e-OFS',
      source: 'NSE Offer for Sale System WEB API Protocol v1.3.0 (Feb 2024)',
      note: 'Column order in the bulk file is still to be confirmed against circular '
          + 'NSE/CMTR/72975 (24 Feb 2026).',
      rows: [
        ['Category is expressed as', 'series (IS / RS / ES) plus clientType (CLI or PRO). There is no category field.'],
        ['A cut-off bid', 'is a MARKET order: isMarketOrder = true, and the price field is left blank.'],
        ['Margin flag', '1 = 100% upfront, 0 = 0% margin.'],
        ['New / modify / cancel', 'operationType E / M / C. CF carries a bid forward to the next day.'],
        ['Client identifier', 'clientId, up to 10 characters.'],
        ['Bid reference', 'orderId, blank on a new bid and returned by the exchange.']
      ]
    },
    BSE: {
      label: 'BSE — iBBS',
      source: 'BSE Notice 20150122-30 (22 Jan 2015), Annexure 1',
      note: 'A bulk file carries at most 100 records; a larger book is split across numbered files.',
      rows: [
        ['Category is expressed as', 'IC, MF, OTHS, NII, RI or RIC — a field in its own right.'],
        ['A cut-off bid', 'goes in category RIC and carries the FLOOR PRICE. "Please mention floor price when category is RIC."'],
        ['Margin flag', '1 = 0% margin, 2 = 100% upfront. Note this is the reverse of NSE.'],
        ['New / modify / cancel', 'Action code N / M / D.'],
        ['Client identifier', 'UCC, up to 12 characters, as registered with the exchange.'],
        ['Bid reference', 'Bid Id, 0 on a new bid; the exchange returns it and it must be quoted to modify or cancel.'],
        ['0% margin bids', 'cannot be cancelled at all, and may only be modified upward in price or quantity. 100% upfront bids allow both.']
      ]
    }
  },

  /* ---- what Ashika adds on top ---- */
  desk: [
    { h: 'Margin',
      p: 'A bid is checked against the client’s available margin before it is accepted. '
       + 'Retail and non-institutional bids are 100% upfront.' },
    { h: 'Cut-off time',
      p: 'Ashika stops accepting bids at its own cut-off, ahead of the exchange close, so the desk '
       + 'has time to assemble and upload the file. Modification and cancellation stop at the same '
       + 'moment.' },
    { h: 'Eligibility',
      p: 'Only an active client account may bid. The check runs against Ashika’s client master '
       + 'at the moment the bid is placed.' },
    { h: 'Record',
      p: 'Every bid, modification and cancellation is recorded with who placed it — the client, '
       + 'their authorised partner, or the back office — and kept. Nothing is deleted.' }
  ]
};
