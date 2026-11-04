// Popup: read the active tab once (activeTab permission), show what was found, open the dashboard.
// Change APP_URL to the deployed app when it is hosted.
const APP_URL = 'http://localhost:8081';

const LABELS = { price: 'Prix', surface: 'Surface', rooms: 'Pièces', type: 'Type', postcode: 'Code postal', town: 'Ville' };
const format = {
  price: (v) => `${Number(v).toLocaleString('fr-FR')} €`,
  surface: (v) => `${String(v).replace('.', ',')} m²`,
  type: (v) => (v === 'house' ? 'Maison' : 'Appartement'),
};

const show = (listing) => {
  const fields = document.getElementById('fields');
  fields.replaceChildren(
    ...Object.entries(LABELS).flatMap(([key, label]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      const value = listing[key];
      dd.textContent = value == null ? 'à compléter' : (format[key] ?? String)(value);
      if (value == null) dd.className = 'missing';
      return [dt, dd];
    }),
  );
  fields.hidden = false;
  const found = Object.keys(LABELS).filter((key) => listing[key] != null).length;
  document.getElementById('status').textContent =
    found === 0 ? 'Aucune donnée trouvée sur cette page : vous pourrez tout saisir.' : `${found} champ(s) trouvé(s).`;
  const button = document.getElementById('open');
  button.disabled = false;
  button.onclick = () => chrome.tabs.create({ url: globalThis.reaListing.dashboardUrl(APP_URL, listing) });
};

const readActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // the parser is injected only now, only in this tab, because the user clicked
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parser.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => globalThis.reaListing.parseListing(globalThis.reaListing.collectPage(document)),
  });
  return result;
};

readActiveTab().then(show, () => {
  document.getElementById('status').textContent = 'Impossible de lire cette page (page système ou bloquée).';
  show({});
});
