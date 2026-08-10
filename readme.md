# Recognition Pretest — Test

# Recognition pretest - Glasgow

A website that shows participants a series of pictures + names (people and places) and asks, one at a time, whether they recognise each one.

## How it works, in brief

1. Participant picks a language. Test currently has `patientIdEntry` turned on, so they are asked for a participant ID.
2. They optionally flag any countries whose people/places they're familiar with.
3. They read one instructions screen, then see stimuli one at a time (a picture and a name) and respond **"I know this"** only if they recognise both together, or **"I don't know this"** otherwise. They can swipe, use the arrow keys, or tap buttons.
4. The session ends automatically once they've said "I know this" to **at least 30 people and at least 60 places** (each threshold configurable per site), or once the
   pool runs out. Once one of the two is satisfied, that type stops appearing — a participant only sees more places once 30 people are locked in, and vice versa, so
   no trials are spent on a quota that's already met.
5. **Every single response is saved locally in the browser immediately** (so refreshing or closing the tab loses nothing on that device). It is possible to turn on `emailEnabled` to email their responses to the researcher. Otherwise, responses can be downloaded at the end.

## Repository layout

```
/images            images of all the concepts + instruction image
app.js             main website logic (behaviour)
concepts.json      all concepts for this site (includes file_name, index, name_<lang>, population, type)
config.js          setting for this site, can be edited to change languages, regions, number of concepts needed, `patientIdEntry`, `emailEnabled`
i18n.js            all text presented to participants in all language options
index.html         structure of website
style.css          appearance of website
```
