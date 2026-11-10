# Portal Evidencia

## Inicio

Instala las dependencias una vez y arranca el portal desde la raíz del proyecto:

```sh
npm install
npm start
```

El punto de entrada compatible es `server.js`; este carga `server_2.js`, que configura Express, autenticación, API y Socket.IO. Por defecto, el servidor escucha en todas las interfaces de red (`HOST=0.0.0.0`) para permitir acceso desde otros dispositivos de la misma red.

## Iniciar desde Visual Studio Code

En Ejecutar y depurar, selecciona **Iniciar servidor Evidencia** y presiona `F5`. VS Code espera el mensaje de servidor listo y abre `http://localhost:3000` en el navegador predeterminado. También puedes iniciar el servidor con `npm start`.

En el teléfono u otra PC de la misma red, abre `http://<IPv4-de-esta-PC>:3000`; puedes consultar la IPv4 con `ipconfig`. El firewall de Windows debe permitir la conexión en la red local. Las cookies de sesión usan `SameSite=Lax` para mantener la autenticación en este acceso desde otro dispositivo.

No expongas este servidor a Internet ni a redes no confiables. Antes de habilitar acceso de red, cambia las contraseñas de demostración y usa el portal únicamente en una red privada confiable.

## Estructura

```text
.
|-- index.html
|-- server.js
|-- server_2.js
|-- src/
|   |-- reports/
|   |   `-- dailyWorkbook.js
|   `-- storage/
|       `-- jsonFile.js
|-- uploads/
|-- daily_reports_files/
|-- users.json
|-- reports.json
|-- messages.json
|-- notifications.json
|-- daily_reports.json
`-- incidencias.json
```

Los directorios y archivos de datos se crean al usarse. Los reportes diarios se conservan en `daily_reports.json` y como archivos `.txt` en `daily_reports_files/`; las incidencias se conservan en `incidencias.json`. El Excel se genera bajo demanda. Los chats y las notificaciones se guardan en sus propios archivos JSON. Estos datos locales están excluidos de Git mediante `.gitignore`.

## Funciones persistentes

- Chat general y privado con historial disponible después de reiniciar el servidor.
- Notificaciones guardadas por usuario, con contador de no leídas y sincronización en tiempo real.
- Reportes diarios guardados con la identidad de la sesión autenticada, descargables como `.txt` y compilables en Excel.
- Descarga de cada archivo cargado por operador y descarga consolidada de los reportes diarios en un único `.txt`; cada rol solo puede descargar los registros permitidos.
- El administrador puede eliminar reportes diarios, archivos cargados e incidencias individualmente. Al eliminar un reporte también se elimina el archivo asociado.
- Reportes diarios con métricas de llamadas, efectividad por zona, solventes no cargadas, pagos expeditos y total de cobranza; el texto libre anterior sigue siendo compatible.
- Registro persistente de reclamos por tarifa y convenios de pago, con razón social, CC, municipio, monto y datos de contacto.
- El Excel consolidado incluye pestañas separadas para reportes, efectivas por zona, pagos expeditos e incidencias.
- Los operadores solo consultan/descargan sus propios reportes; supervisores y administradores pueden consultar el conjunto.
