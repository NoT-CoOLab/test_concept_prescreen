// Site-specific configuration for FRANKFURT.
// See "WHERE RESPONSES GET SENT" below for backend setup — currently configured for
// the email-relay backend (email-relay/DEPLOY.md).
const CONFIG = {
  siteId: "test",
  siteName: "Test",

  languages: ["en", "de", "sl"],
  languageLabels: { en: "English", de: "Deutsch", sl: "Slovenščina" },

  // Countries participants can flag as "I know people/places from here especially well".
  // This is about familiarity, not identity — a participant can select none or several.
  // "population" must match a value in the population column of concept_list.xlsx.
  regions: [
    { code: "DE", population: "German", label: { en: "Germany", de: "Deutschland" } }
  ],

  // The session ends automatically once BOTH of these are reached (whichever comes
  // later keeps it going) — or once the participant's pool runs out entirely.
  minPeopleKnown: 30,
  minPlacesKnown: 60,

  // ↓↓↓ WHERE RESPONSES GET SENT ↓↓↓
  //
  // backend: "email-relay" (default here) — see email-relay/DEPLOY.md. No live lookup
  //   exists, so cross-device resume-by-code isn't available; same-device resume
  //   (browser storage) always works regardless.
  //
  backend: "email-relay",
  crossDeviceResumeSupported: false,

  // The email-relay flow sends the final file to both — see email-relay/DEPLOY.md.
  // (Currently only one recipient is set — add the doctor's email here when you have
  // it; the flow and app both handle either 1 or 2 recipients cleanly.)
  notifyEmails: ["2557636O@student.gla.ac.uk"],

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
  // from reaching your inbox. Lower = safer but burns EmailJS's free 200/month quota
  // faster (roughly trials-per-session ÷ this number, per participant). 25 is a
  // reasonable starting point — see email-relay/DEPLOY.md for the quota math.
  checkpointEveryNResponses: 25,

};
