/**
 * Hebrew / English for every page. Loaded first and synchronously, so the
 * language and direction are settled before anything paints; [data-i18n]
 * markup is translated once the DOM is ready, and pages call i18n.t() for the
 * text they build themselves.
 *
 * Which language: a ?lang= link, else the toggle's saved choice, else the
 * browser's preferences -- the first of Hebrew or English it lists. A browser
 * that lists neither gets English.
 *
 * The page layout is the Hebrew one in both languages -- the sidebar on the
 * right, the add button on the left -- so <html> is always dir="rtl". Only the
 * text changes direction: in English, the stylesheets turn the text blocks
 * (sidebar, popups, form, header labels) left-to-right; see `html[lang="en"]`.
 *
 * Only the site's own interface is translated. Restaurant information -- names,
 * addresses, cities, hechsherim, types, regions -- stays exactly as in the data,
 * in Hebrew, on the map and in what the form stores.
 */
(() => {
  'use strict';

  const SUPPORTED = ['he', 'en'];
  const STORE_KEY = 'lang';

  function pick() {
    const fromUrl = new URLSearchParams(location.search).get('lang');
    if (SUPPORTED.includes(fromUrl)) return fromUrl;
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (SUPPORTED.includes(saved)) return saved;
    } catch { /* storage blocked: fall through to the browser */ }
    for (const l of navigator.languages || [navigator.language || '']) {
      const base = String(l).toLowerCase().split('-')[0];
      if (base === 'he' || base === 'iw') return 'he';
      if (base === 'en') return 'en';
    }
    return 'en';
  }

  const lang = pick();
  const root = document.documentElement;
  root.lang = lang;
  root.dir = 'rtl'; // the layout; English text is turned LTR block by block in CSS
  // The markup is written in Hebrew; hide it until translated so English
  // readers never see it flash.
  if (lang !== 'he') root.setAttribute('data-i18n-pending', '');

  // Numbers inside Hebrew text get left-to-right isolates, or the digits and
  // commas of "02-5377000, 054-1234567" are reordered around each other.
  const ltr = (s) => `⁦${s}⁩`;
  const PHONES = ['02-5377000', '054-1234567', '1-700-500-500', '*2242'];

  const STRINGS = {
    he: {
      'title.map': 'מפת מסעדות כשרות בישראל',
      'desc.map': 'מפה של מסעדות בהשגחה בישראל, עם סינון לפי עיר, אזור, סוג וכשרות.',
      'title.add': 'הוספת מסעדה · מפת מסעדות כשרות',
      'title.update': 'עדכון מסעדה · מפת מסעדות כשרות',
      'desc.update': 'עדכון פרטים או דיווח על מסעדה במפת המסעדות הכשרות.',
      'update.heading': 'עדכון מסעדה',
      'update.current': 'הפרטים במפה כרגע',
      'update.what': 'מה תרצו לעדכן?',
      'update.kind.closed': 'המקום נסגר',
      'update.kind.details': 'פרטים שגויים או חסרים',
      'update.kind.other': 'משהו אחר',
      'update.correctTitle': 'תיקון הפרטים',
      'update.correctHint': 'שנו רק את מה שלא נכון. תיקון מתקבל כששני אנשים שונים מדווחים אותו דבר, או אחרי בדיקה.',
      'update.details.optional': 'פרטים נוספים (לא חובה)',
      'update.details.required': 'מה צריך לתקן?',
      'update.notFound': 'המסעדה לא נמצאה במפה.',
      'done.update': 'תודה על העדכון!',
      'st.noChanges': 'לא שונה אף פרט.',
      'st.chooseKind': 'נא לבחור מה לעדכן.',
      'field.details': 'פרטים',
      'pop.update': 'עדכון / דיווח',
      'confirm.ask': 'האם הפרטים נכונים?',
      'confirm.yes': 'כן, נכון',
      'confirm.no': 'לא — לעדכון',
      'confirm.count': '{n} מתוך {needed} אישרו',
      'confirm.thanks': 'תודה על האישור!',
      'confirm.failed': 'לא הצלחנו לשלוח. נסו שוב.',
      'desc.add': 'הוספת מסעדה בהשגחה למפת המסעדות הכשרות בישראל.',
      brand: 'מסעדות בהשגחה',
      loading: 'טוען…',
      'add.prompt': 'חסרה מסעדה?',
      'add.button': 'הוספת מסעדה',
      filters: 'סינון',
      'sidebar.label': 'סינון תוצאות',
      'search.label': 'חיפוש חופשי',
      'search.placeholder': 'שם מסעדה, רחוב או עיר',
      'facet.types': 'סוג',
      'facet.areas': 'אזור',
      'facet.cities': 'עיר',
      'facet.hechsherim': 'כשרות',
      clear: 'נקה',
      'city.search': 'חפש עיר…',
      'city.searchLabel': 'חיפוש עיר',
      'city.none': 'אין ערים תואמות',
      'city.otherArea': 'אחר',
      reset: 'אפס את כל הסינונים',
      'status.loading': 'טוען נתונים…',
      'status.error': 'שגיאה בטעינת הנתונים',
      'status.none': 'אין תוצאות לסינון הנוכחי',
      'status.noneMapped': 'לאף תוצאה אין מיקום על המפה',
      unmapped: '{n} ללא מיקום מדויק',
      'count.all': '{n} מסעדות',
      'count.some': '{n} מתוך {total}',
      'meta.updated': 'עודכן: {date}',
      'meta.source': 'מקור הנתונים: בהשגחה',
      'meta.counts': '{mapped} ממופות, {unmapped} ללא מיקום',
      'pop.address': 'כתובת',
      'pop.kashrut': 'כשרות',
      'pop.type': 'סוג',
      'pop.phone': 'טלפון',
      'pop.approx.street': 'מיקום משוער — הרחוב אותר, אך לא מספר הבית.',
      'pop.approx.city': 'מיקום משוער — מרכז העיר בלבד, לא נמצאה כתובת מדויקת.',
      'pop.navigate': 'ניווט',
      'pop.details': 'פרטים',
      'pop.call': 'חיוג',
      'pop.hours': 'שעות',
      'pins.all': 'הצגת כל הנקודות',
      'pop.website': 'אתר',
      'pop.whatsapp': 'וואטסאפ',
      'pop.community': 'נוסף ע״י הקהילה',
      'lang.other': 'English',
      'lang.short': 'EN',
      'lang.switch': 'Switch to English',

      'add.heading': 'הוספת מסעדה',
      back: 'חזרה למפה',
      'section.main': 'פרטי המסעדה',
      'section.advanced': 'פרטים נוספים (לא חובה)',
      'note.text': 'אפשר להגיש את המסעדה גם ישירות לאתר בהשגחה. הגשות שם עוברות אישור של צוות האתר, ולכן עשוי לעבור זמן עד שהמסעדה תופיע.',
      'note.link': 'להגשה באתר בהשגחה',
      required: 'שדה חובה',
      private: ' (יוצג רק למנהל האתר)',
      choose: 'בחרו…',
      unknown: 'לא ידוע',
      'placeholder.url': 'https://… או ‎@instagram',
      'hint.phone': `לדוגמה ${PHONES.slice(0, -1).map(ltr).join(', ')} או ${ltr(PHONES.at(-1))}`,
      'hint.hebrew': '',
      'err.required': 'שדה חובה',
      'err.too_long': 'עד {max} תווים',
      'err.invalid': 'ערך לא חוקי',
      'err.bad_phone': 'מספר טלפון לא תקין',
      'err.not_found': 'מסעדה לא נמצאה',
      'dupes.title': 'ייתכן שהמסעדה כבר במפה:',
      'dupes.note': 'אם זו מסעדה אחרת (למשל סניף נוסף), אפשר להמשיך.',
      'dupes.show': 'הצגה במפה',
      'city.converted': 'שם העיר נשמר בעברית: {city}',
      'places.searching': 'מחפש…',
      'places.noNumber': 'מספר הבית לא מופיע במפה',
      'places.credit': 'הצעות: Photon · © OpenStreetMap',
      submit: 'שליחה',
      'st.fix': 'יש לתקן את השדות המסומנים.',
      'st.captcha': 'נא לאשר את בדיקת האבטחה למטה.',
      'st.sending': 'שולח…',
      'st.offline': 'אין חיבור לשרת. נסו שוב בעוד רגע.',
      'st.limit': 'הגעתם למספר ההגשות המרבי להיום. אפשר לנסות שוב מחר.',
      'st.captchaFailed': 'בדיקת האבטחה נכשלה. נסו שוב.',
      'st.server': 'משהו השתבש בשרת. נסו שוב מאוחר יותר.',
      'st.notOpen': 'הטופס עוד לא פתוח להגשות. אפשר להגיש בינתיים באתר בהשגחה (בפרטים נוספים).',
      'st.captchaLoad': 'בדיקת האבטחה לא נטענה. רעננו את הדף.',
      privacy: 'מה נשמר: פרטי המסעדה שהוזנו. טלפונים של בעלים ומשגיח ותפקידכם במקום נראים רק למנהל האתר. ' +
        'למניעת ספאם נשמר מזהה מוצפן חד־כיווני של כתובת ה־IP, ונמחק אחרי 30 יום. ' +
        'כתובות מוצעות בעזרת Photon (OpenStreetMap), שמקבל את מה שמקלידים בשדות הכתובת והעיר; ' +
        'בדיקת האבטחה של Cloudflare Turnstile.',
      'done.title': 'תודה על ההגשה!',
      'done.again': 'הוספת מסעדה נוספת',

      'field.name': 'שם המסעדה',
      'field.address': 'כתובת',
      'field.city': 'עיר',
      'field.type': 'בשרי / חלבי / פרווה',
      'field.hechsher': 'כשרות',
      'field.phone': 'טלפון',
      'field.description': 'תיאור קצר',
      'field.whatsapp': 'וואטסאפ',
      'field.website': 'אתר / אינסטגרם',
      'field.hours': 'שעות פתיחה',
      'field.delivery': 'יש משלוחים?',
      'field.accessible': 'המקום נגיש?',
      'field.reservation': 'חובה להזמין מקום?',
      'field.submitterRole': 'הקשר שלך למקום',
      'field.ownerPhone': 'טלפון בעלים',
      'field.mashgiachPhone': 'טלפון משגיח',
    },

    en: {
      'title.map': 'Kosher Restaurant Map · Israel',
      'desc.map': 'A map of kosher-supervised restaurants in Israel, filterable by city, region, type and hechsher.',
      'title.add': 'Add a restaurant · Kosher Restaurant Map',
      'title.update': 'Update a restaurant · Kosher Restaurant Map',
      'desc.update': 'Correct the details of a restaurant on the kosher restaurant map, or report a problem.',
      'update.heading': 'Update a restaurant',
      'update.current': 'On the map now',
      'update.what': 'What would you like to tell us?',
      'update.kind.closed': 'It has closed',
      'update.kind.details': 'Some details are wrong or missing',
      'update.kind.other': 'Something else',
      'update.correctTitle': 'Correct the details',
      'update.correctHint': 'Change only what is wrong. A correction is accepted once two different people report the same thing, or after review.',
      'update.details.optional': 'Anything to add? (optional)',
      'update.details.required': 'What needs fixing?',
      'update.notFound': 'This restaurant was not found on the map.',
      'done.update': 'Thanks for your update!',
      'st.noChanges': 'Nothing was changed.',
      'st.chooseKind': 'Please choose what to tell us.',
      'field.details': 'Details',
      'pop.update': 'Update / report',
      'confirm.ask': 'Is this correct?',
      'confirm.yes': 'Yes, it is',
      'confirm.no': 'No – update it',
      'confirm.count': '{n} of {needed} confirmed',
      'confirm.thanks': 'Thanks for confirming!',
      'confirm.failed': 'Couldn\'t send that. Please try again.',
      'desc.add': 'Add a kosher-supervised restaurant to the map of kosher restaurants in Israel.',
      brand: 'Kosher Restaurants',
      loading: 'Loading…',
      'add.prompt': 'Missing a restaurant?',
      'add.button': 'Add a restaurant',
      filters: 'Filters',
      'sidebar.label': 'Filter results',
      'search.label': 'Search',
      'search.placeholder': 'Restaurant, street or city',
      'facet.types': 'Type',
      'facet.areas': 'Region',
      'facet.cities': 'City',
      'facet.hechsherim': 'Hechsher',
      clear: 'Clear',
      'city.search': 'Find a city…',
      'city.searchLabel': 'Search cities',
      'city.none': 'No matching cities',
      'city.otherArea': 'Other',
      reset: 'Reset all filters',
      'status.loading': 'Loading data…',
      'status.error': 'Could not load the data',
      'status.none': 'No restaurants match these filters',
      'status.noneMapped': 'None of the results has a location on the map',
      unmapped: '{n} without an exact location',
      'count.all': '{n} restaurants',
      'count.some': '{n} of {total}',
      'meta.updated': 'Updated {date}',
      'meta.source': 'Data: בהשגחה (rest.jdn.co.il)',
      'meta.counts': '{mapped} mapped, {unmapped} without a location',
      'pop.address': 'Address',
      'pop.kashrut': 'Hechsher',
      'pop.type': 'Type',
      'pop.phone': 'Phone',
      'pop.approx.street': 'Approximate location: the street was found, but not the house number.',
      'pop.approx.city': 'Approximate location: city center only; no exact address was found.',
      'pop.navigate': 'Directions',
      'pop.details': 'Details',
      'pop.call': 'Call',
      'pop.hours': 'Hours',
      'pins.all': 'Show all pins',
      'pop.website': 'Website',
      'pop.whatsapp': 'WhatsApp',
      'pop.community': 'Added by the community',
      'lang.other': 'עברית',
      'lang.short': 'עב',
      'lang.switch': 'החלפה לעברית',

      'add.heading': 'Add a restaurant',
      back: 'Back to map',
      'section.main': 'Restaurant details',
      'section.advanced': 'More details (optional)',
      'note.text': 'You can also submit the restaurant directly to בהשגחה (rest.jdn.co.il). Their team reviews submissions, so it may take a while to appear there.',
      'note.link': 'Submit on בהשגחה',
      required: 'Required',
      private: ' (seen only by the site admin)',
      choose: 'Choose…',
      unknown: 'Not sure',
      'placeholder.url': 'https://… or @instagram',
      'hint.phone': `e.g. ${PHONES.slice(0, -1).join(', ')} or ${PHONES.at(-1)}`,
      'hint.hebrew': 'Type in English or Hebrew. Places are saved in Hebrew, as they appear on the map.',
      'err.required': 'Required',
      'err.too_long': 'Up to {max} characters',
      'err.invalid': 'Invalid value',
      'err.bad_phone': 'Invalid phone number',
      'err.not_found': 'Restaurant not found',
      'dupes.title': 'This restaurant may already be on the map:',
      'dupes.note': 'If it is a different place (another branch, say), carry on.',
      'dupes.show': 'Show on map',
      'city.converted': 'City saved in Hebrew, as on the map: {city}',
      'places.searching': 'Searching…',
      'places.noNumber': 'house number not on the map',
      'places.credit': 'Suggestions: Photon · © OpenStreetMap',
      submit: 'Submit',
      'st.fix': 'Please fix the highlighted fields.',
      'st.captcha': 'Please complete the security check below.',
      'st.sending': 'Sending…',
      'st.offline': 'Could not reach the server. Try again in a moment.',
      'st.limit': 'You have reached today\'s submission limit. Try again tomorrow.',
      'st.captchaFailed': 'The security check failed. Please try again.',
      'st.server': 'Something went wrong on the server. Please try again later.',
      'st.notOpen': 'The form is not open for submissions yet. Meanwhile you can submit on בהשגחה (under More details).',
      'st.captchaLoad': 'The security check did not load. Please refresh the page.',
      privacy: 'What is stored: the restaurant details you enter. Owner and mashgiach phones and your relation to the place are seen only by the site admin. ' +
        'To prevent spam, a one-way hash of your IP address is kept and deleted after 30 days. ' +
        'Address suggestions come from Photon (OpenStreetMap), which receives what you type into the address and city fields; ' +
        'the security check is Cloudflare Turnstile.',
      'done.title': 'Thanks for your submission!',
      'done.again': 'Add another restaurant',

      'field.name': 'Restaurant name',
      'field.address': 'Address',
      'field.city': 'City',
      'field.type': 'Meat / Dairy / Pareve',
      'field.hechsher': 'Hechsher',
      'field.phone': 'Phone',
      'field.description': 'Short description',
      'field.whatsapp': 'WhatsApp',
      'field.website': 'Website / Instagram',
      'field.hours': 'Opening hours',
      'field.delivery': 'Delivery?',
      'field.accessible': 'Wheelchair accessible?',
      'field.reservation': 'Reservation required?',
      'field.submitterRole': 'Your relation to the place',
      'field.ownerPhone': 'Owner\'s phone',
      'field.mashgiachPhone': 'Mashgiach\'s phone',
    },
  };

  // The form's own answer buttons, shown in English; the stored value stays
  // Hebrew. (Restaurant information itself is never translated.)
  const CHOICES_EN = {
    'כן': 'Yes',
    'לא': 'No',
    'בעלים / צוות': 'Owner / staff',
    'לקוח': 'Customer',
    'אחר': 'Other',
  };

  function t(key, params = {}) {
    const s = STRINGS[lang][key] ?? STRINGS.he[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
  }

  /**
   * Makes a text box read in the direction of what is typed into it: Hebrew
   * right to left on the English page, English left to right on the Hebrew one.
   * dir="auto" alone can't do this -- an empty box with it turns left-to-right
   * even on the Hebrew page; here an empty box keeps the page's direction.
   */
  function followTypedDirection(input) {
    const set = () => {
      const first = (input.value.match(/\p{L}/u) || [])[0];
      if (!first) input.removeAttribute('dir');
      else input.dir = /[\p{Script=Hebrew}\p{Script=Arabic}]/u.test(first) ? 'rtl' : 'ltr';
    };
    input.addEventListener('input', set);
    input.addEventListener('change', set);
    set();
    return set; // call after setting the value from code
  }

  /** A form answer button's label (yes/no, relation to the place). */
  const choice = (v) => (lang === 'en' ? CHOICES_EN[v] || v : v);

  function apply(scope = document) {
    for (const node of scope.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const node of scope.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of node.dataset.i18nAttr.split(';')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) node.setAttribute(attr, t(key));
      }
    }
    root.removeAttribute('data-i18n-pending');
  }

  /**
   * Switches language: remembers the choice, puts it in the URL (so a shared
   * link opens in it) and reloads, keeping the #hash -- the map's filters. Pages
   * listen for 'i18n:beforeswitch' to stash anything they want to keep.
   */
  function switchTo(next) {
    document.dispatchEvent(new CustomEvent('i18n:beforeswitch'));
    try { localStorage.setItem(STORE_KEY, next); } catch { /* the URL still carries it */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', next);
    location.replace(url.href);
  }

  /** Fills every [data-lang-toggle] button: it names the other language. */
  function mountToggles() {
    const other = lang === 'he' ? 'en' : 'he';
    for (const btn of document.querySelectorAll('[data-lang-toggle]')) {
      const long = Object.assign(document.createElement('span'), { className: 'long', textContent: t('lang.other') });
      const short = Object.assign(document.createElement('span'), { className: 'short', textContent: t('lang.short') });
      btn.replaceChildren(long, short);
      btn.setAttribute('lang', other);
      btn.setAttribute('aria-label', t('lang.switch'));
      btn.addEventListener('click', () => switchTo(other));
    }
  }

  // Internal links keep the chosen language (index <-> add).
  function keepLangInLinks() {
    if (!new URLSearchParams(location.search).has('lang')) return;
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!/^[\w-]+\.html(#|$)/.test(href)) continue;
      const url = new URL(href, location.href);
      url.searchParams.set('lang', lang);
      a.setAttribute('href', `${url.pathname.split('/').pop()}${url.search}${url.hash}`);
    }
  }

  function ready() {
    apply();
    mountToggles();
    keepLangInLinks();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.i18n = { lang, t, choice, apply, switchTo, followTypedDirection };
})();
