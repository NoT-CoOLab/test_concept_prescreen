// Configuration for test
const CONFIG = {
  // Short lowercase id, no spaces — used in filenames. e.g. "vienna"
  siteId: "Test",

  // Human-readable name shown in the header. e.g. "Vienna"
  siteName: "Test",

  // Which of "en" / "de" / "sl" (or other codes you add strings for in i18n.js) this site offers.
  languages: ["en", "de", "sl", "tur", "ukr", "rus"],
  languageLabels: { en: "English", de: "Deutsch", sl: "Slovenščina", tur: "Türkçe", ukr: "український", rus: "русский" },

  // Countries participants can flag as "I know people/places from here especially well".
  // This is about familiarity, not identity — a participant can select none or several.
  // "population" must match a value you use in the population column of
  // stimuli.xlsx for this site's local concepts. Empty by default — this template
  // has no local pool until you add one, e.g.:
  //   regions: [{ code: "AT", population: "Austrian", label: { en: "Austria" } }]
  regions: [
    { code: "DE", population: "German", label: { en: "Germany", de: "Deutschland", sl: "Nemčija", tur: "Almanya", ukr: "Німеччина", rus: "Германия" } },
    { code: "SI", population: "Slovenian", label: { en: "Slovenia", de: "Slowenien", sl: "Slovenija", tur: "Slovenya", ukr: "Словенія", rus: "Словения" } },
    { code: "CN", population: "Chinese", label: { en: "China", de: "China", sl: "Kitajska", tur: "Çin", ukr: "Китай", rus: "Китай", zh: "中国" } },
    { code: "IN", population: "Indian", label: { en: "India", de: "Indien", sl: "Indija", tur: "Hindistan", ukr: "Індія", rus: "Индия" } },
    { code: "SCT", population: "Scottish", label: { en: "Scotland", de: "Schottland", sl: "Škotska", tur: "İskoçya", ukr: "Шотландія", rus: "Шотландия" } }
  ],

  // The session ends automatically once BOTH of these are reached (whichever comes
  // later keeps it going) — or once the participant's pool runs out entirely.
  minPeopleKnown: 30,
  minPlacesKnown: 60,

  // Whether this site emails data out at all. false means: no periodic checkpoints,
  // no attempt at finish, and the "thank you" screen goes straight to a prominent
  // download button instead — useful for a site where automatic sending genuinely
  // isn't needed. Everything below this line (notifyEmails, emailjs, etc.) is only
  // read when this is true.
  emailEnabled: false,

  // ↓↓↓ WHERE RESPONSES GET SENT — see email-relay/DEPLOY.md ↓↓↓

  // Recipients who get EVERY checkpoint email (periodic + finish) — typically just you.
  notifyEmails: ["2557636O@student.gla.ac.uk"],

  // Recipients who only get the FINAL email (e.g. a supervising doctor who doesn't
  // need the periodic in-progress copies) — leave empty for nobody in this category.
  // Add an address here like: finalOnlyEmails: ["doctor@example.com"]
  finalOnlyEmails: [],

  emailjs: {
    // From your EmailJS account (emailjs.com) — see email-relay/DEPLOY.md step 1.
    serviceId: "service_4uk9pme",
    templateId: "template_cfu2vxg",
    publicKey: "EwhmkGZQxElwNgFu0",
    // Where the raw checkpoint data lands first — your own Outlook inbox, watched by
    // the Power Automate flow. Not the final recipients (see notifyEmails above).
    ingressTo: "2557636O@student.gla.ac.uk"
  },

  // Safety-net cadence: also send a checkpoint after this many responses, not just at
  // finish, so an abrupt tab close doesn't lose more than this many responses
  // from reaching your inbox. 25 is a reasonable starting point — see
  // email-relay/DEPLOY.md for the quota math.
  checkpointEveryNResponses: 1000
};
