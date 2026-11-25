# MixMaker

Editor multipista de audio en el navegador, con temas Dark, White y Purple.

## Estructura del proyecto

```text
MixMaker/
├── index.html
├── css/
│   └── styles.css
├── js/
│   ├── app.js
│   ├── audio/
│   │   ├── engine.js
│   │   ├── effects.js
│   │   └── export.js
│   ├── timeline/
│   │   ├── tracks.js
│   │   ├── clips.js
│   │   └── renderer.js
│   ├── ui/
│   │   ├── themes.js
│   │   ├── controls.js
│   │   └── inspector.js
│   └── storage/
│       └── project.js
└── README.md
```

## Responsabilidades

- `js/app.js`: inicialización y coordinación de la aplicación; conserva los flujos de edición y eventos.
- `js/audio/engine.js`: inicialización de Web Audio API.
- `js/audio/effects.js`: valores por defecto y utilidades DSP de efectos.
- `js/audio/export.js`: creación de cabeceras WAV.
- `js/timeline/tracks.js`: fábrica de pistas.
- `js/timeline/clips.js`: fábrica y geometría básica de clips.
- `js/timeline/renderer.js`: dibujo de ondas y cálculo del ancho del timeline.
- `js/ui/themes.js`: selector Dark / White / Purple.
- `js/ui/controls.js`: notificaciones y anuncios accesibles.
- `js/ui/inspector.js`: renderizado de campos del inspector.
- `js/storage/project.js`: apertura de IndexedDB y serialización de proyectos.
- `css/styles.css`: estilos, tipografía, responsive y temas.

## Ejecutar

Como la aplicación usa módulos JavaScript (`type="module"`), ejecútala desde un servidor local, no abriendo el HTML directamente con `file://`.

Desde esta carpeta:

```bash
python -m http.server 8000
```

Abre `http://localhost:8000`.

## Nota de arquitectura

Esta es una primera modularización funcional: se extrajeron servicios y utilidades con responsabilidades claras, mientras `app.js` sigue coordinando los flujos que comparten el estado del proyecto. La siguiente fase puede separar también los controladores de interacción y el renderizado completo del inspector/timeline.
