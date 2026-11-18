# Oura Health Tracker

Privatni dashboard s dnevnim i mjesečnim pregledom te trendovima Oura mjerenja. Svaki korisnik ima vlastiti račun, daje OAuth odobrenje za svoj Oura račun i može pristupiti samo svojim mjerenjima.

## Cloudflare

- Worker **oura-health-tracker** koristi postojeći D1 binding `DB` na **oura-health-db**. Očekuje postojeće tablice `users`, `sessions` i `auth_attempts` te postojeći Secret `AUTH_MASTER_KEY`. Nadogradnja ne mijenja lozinke ili postojeće sesije.
- Worker provjerava i primjenjuje dodatnu shemu iz `migrations/0001_oura.sql` pri prvom zakazanom pokretanju. Administrator može ranije pokrenuti istu migraciju izradom pozivnice. Po potrebi se SQL može primijeniti i iz D1 Console.
- U [Oura My Applications](https://cloud.ouraring.com/oauth/applications) registriraj aplikaciju. Postavi web-adresu `https://oura-health-tracker.krnic-damir.workers.dev` i točan OAuth callback `https://oura-health-tracker.krnic-damir.workers.dev/oura/callback`.
- Na postojećem Workeru u **Settings → Variables and Secrets** spremi `OURA_CLIENT_ID` i `OURA_CLIENT_SECRET`. Tajni ključ spremi kao **Secret**. `OURA_LIVE=true` uključuje povezivanje i dohvat isključivo ako su obje postavke dostupne.
- U aplikaciji se prijavi i odaberi **Poveži Oura račun**. Oura traži korisnikovo odobrenje za dnevne sažetke i podatke o snu (`daily`).
- Izbornik **Moj račun** administratoru omogućuje izradu jednokratne pozivnice koja vrijedi 24 sata. Pozvani korisnik postavlja vlastitu lozinku i daje vlastito Oura odobrenje.

## Sinkronizacija

Prvi uvoz počinje posljednjim mjesecom mjerenja. Zakazano pokretanje svakih 15 minuta nastavlja uvoz do početka 14. kalendarskog mjeseca u prikazu. Nakon početnog uvoza Worker otprilike svaki sat ponovo povlači posljednjih osam dana radi naknadnih izmjena. Ručno osvježavanje dopušteno je najranije pet minuta nakon uspješne sinkronizacije, uz poštivanje čekanja koje je propisala Oura.

U D1 se spremaju pokazatelji koje dashboard prikazuje. OAuth tokeni šifriraju se AES-GCM ključem izvedenim iz postojećeg Cloudflare secreta pomoću HKDF-a. Rotacija `AUTH_MASTER_KEY` zahtijeva plan za postojeće lozinke i Oura veze. Ponovno povezivanje zamjenjuje postojeću vezu i ponovno uvozi mjerenja odabranog Oura računa.

## Provjera objave

Nakon svake objave provjeri da neprijavljeni zahtjevi na `/` i `/index.html` vode na `/login` te da `/api/health` vraća HTTP 401 uz `Cache-Control: no-store, private`. Za funkcionalnu provjeru prijavi se, otvori **Moj račun**, provjeri stanje veze i nakon Oura odobrenja provjeri datum zadnje sinkronizacije i stvarna mjerenja.
