# Beispiel-Kamera im Demo-Modus

Im Demo-Modus zeigt die Kamera-Seitenleiste eine kurze Schleife (`apps/web/public/demo-camera.webm`, 20 s, 640×360).
Es ist keine echte Kamera, sondern eine gezeichnete Draufsicht auf einen Rundkurs mit zwei fahrenden Zügen.
Sobald eine eigene Kamera eingerichtet ist, ersetzt sie das Beispiel.

`cam.html` ist die Quelle der Animation (Canvas, Periode 20 s). Neu aufnehmen: die Seite im Browser mit 640×360 Pixeln
öffnen, 20 Sekunden mitschneiden (zum Beispiel mit Playwright `recordVideo`) und als VP8-WebM ablegen.
