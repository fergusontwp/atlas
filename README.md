# Atlas

Atlas is a web map viewer for parcel data. It is built on the ArcGIS Maps SDK for JavaScript. It is a static site: there is no build step and no server code.

This repository is a public copy of the code. It contains no data. The data stays in ArcGIS Online, and the app asks users to sign in.

## Features

- Click a map feature to see its pop-up. The top layer is shown first. If several features are at the click, you can page through them.
- Make one layer the only selectable layer. Reset it at any time.
- Switch between symbology presets, including natural-breaks classes.
- Filter parcels by attribute. A live count shows how many are visible.
- Search by parcel ID, owner, or address. Share a link to a parcel.
- Parcel labels, GIS area and perimeter labels, and edge-length labels.
- Measure length and area. Change the basemap.
- "What's in this parcel": find features in other layers that intersect a parcel or are near it. View the results in a table. Download them as CSV or Excel.
- Georeference a plan PDF to the map and save it to a hosted layer (optional).
- Print map: frame the map, add a title, scale bar, north arrow, legend, notes, callouts, and sketches. Export a PDF or PNG.

## What you need

- An ArcGIS Online organization (or ArcGIS Enterprise portal).
- A web map that contains your parcel layer and other layers.
- An OAuth application item in ArcGIS Online (this gives you a client ID).
- For the georeferencing feature only: a hosted feature layer with attachments. The fields are listed in `config.js` under `PLANS.FIELDS`.
- A current desktop Chrome or Edge browser.

## Set up

1. Download or clone this repository.
2. Open `config.js`. Replace these values with your own:
   - `WEBMAP_ITEM_ID`: the ID of your web map.
   - `APP_ID`: the client ID of your OAuth application.
   - `PORTAL_URL`: your portal URL.
   - `PARCEL_LAYER_TITLE`: the title of the parcel layer in your web map.
   - `PLANS.ITEM_ID`: your hosted plans layer (leave it unchanged to turn the feature off).
3. Check the field names in `config.js` (for example `SEARCH`, `LABELS`, and `FILTER`). They match one specific parcel schema. A field that your layer does not have is skipped, with a warning in the browser console.
4. In ArcGIS Online, add your redirect URL to the OAuth application:

```
python -m http.server 8000
```

Do not open `index.html` as a file. The browser blocks module imports from `file://`.

## Deploy

Use GitHub Pages. Publish the repository root. Add the Pages URL to the OAuth redirect list (step 4).

## Privacy and access

The code holds no secrets. The client ID and item IDs are public identifiers. ArcGIS Online checks the signed-in user's permissions on every request. Set the sharing level of your web map, each layer, and any hosted layer yourself. Some features can show owner names or other personal data if your layers contain them. Check your own data and policies before you give people access.

## Limits

- Desktop browsers only. Tested mainly in Chrome.
- Area, length, and edge values are planar approximations. They are not survey values.
- Printed maps are for reference only. They are not legal documents or surveys.
- The SDK is pinned to version 5.1. Newer versions can change behavior.
- This public copy does not include the test files.

## Third-party software

The ArcGIS Maps SDK for JavaScript and Calcite Design System load from Esri's CDN. They are not part of this repository. Esri's terms apply to their use. pdf.js (Apache-2.0) loads from jsDelivr when you open the georeferencing workspace. Esri and ArcGIS are trademarks of Esri. This project is not affiliated with or endorsed by Esri.

## License

MIT. See the `LICENSE` file.

## Disclaimer

This software has no warranty. See the license. The maps and outputs are for reference only.