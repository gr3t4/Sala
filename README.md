# Sala — plataforma de streaming

Web app de videos para clientes con acceso controlado por el administrador.
Funciona en PC, celular y navegador de Smart TV (navegación con control remoto).

- Frontend: un solo `index.html` (HTML + JS, sin compilación)
- Backend: Supabase (Auth, tablas `st_*` con RLS, buckets `st-videos` privado y `st-miniaturas` público)

## Despliegue
Sitio estático: Vercel lo publica tal cual (Framework preset: **Other**, sin build command).
Después de desplegar, en Supabase → Authentication → URL Configuration pon la URL de Vercel como **Site URL** y agrégala en **Redirect URLs**.

## Primer uso
1. Entra, toca **Crear cuenta** con tu correo y luego **Hacerme administrador** (solo funciona para el primero).
2. En **Administrar → Clientes** da de alta los correos de tus clientes; ellos crean su cuenta con ese correo.

El nombre visible se cambia en `const NOMBRE` al inicio del script.
