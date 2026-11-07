# CampusFit website

The source for [campusfit.ca](https://campusfit.ca). It's a plain HTML/CSS site hosted for free on GitHub Pages. There's no build step: whatever is in this repository is what the site shows.

## Where things are

| Page | File |
|---|---|
| Home | `index.html` |
| Services | `services/index.html` |
| Find a Trainer | `find-a-trainer/index.html` |
| Resources | `resources/index.html` |
| Success Stories | `success-stories/index.html` |
| Our Team | `team/index.html` |
| Contact Us | `contact-us/index.html` |
| Page not found | `404.html` |

- Styles (colours, fonts, spacing) are in `assets/style.css`. The colours are defined at the top of that file.
- Photos are in `images/`. The handbook PDF is in `files/`.
- The header and footer are repeated in every page. If you change a menu item or the footer, change it in every HTML file.

## Find a Trainer map

- The map code is `assets/finder.js` and its styles are `assets/finder.css`. It uses Leaflet with OpenStreetMap tiles; no API key needed.
- CampusFit trainers come from a Google Sheet. Paste the sheet tab's **Publish to web → CSV** link into `TRAINERS_CSV_URL` at the top of `assets/finder.js`.
- Sheet columns (header names): Approved, Full name, Gym or business name, Address, Latitude, Longitude, Services, Rates, Phone, Contact email, Website, Instagram, Trains online, Bio, Photo URL. Only rows with Approved = Yes appear. Rows without Latitude/Longitude are placed by looking up the address.
- The "Get listed" button goes to `SIGNUP_URL` in `assets/finder.js`.
- Gyms and studios are loaded live from OpenStreetMap when the map is zoomed in.

## Making a change

1. Open the file on github.com and click the pencil icon (Edit).
2. Change the text between the tags. For example, replace `Bio coming soon.` with a real bio.
3. Click **Commit changes**. The live site updates within a minute or two.

To replace a photo, upload a new file with the **same name** into `images/` using **Add file → Upload files**.

## Forms and links

- Online Personal Training sign-up, form checks and Q&A all use Google Forms. The links are in `services/index.html` and `contact-us/index.html`.
- Video tutorials live in a Google Drive folder, linked from `resources/index.html`.
- Contact email: infocampusfit@gmail.com
