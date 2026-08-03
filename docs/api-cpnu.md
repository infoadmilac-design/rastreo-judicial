# API oficial Rama Judicial — CPNU v2

Consulta de Procesos Nacional Unificada. JSON puro y gratuito. No requiere API key.
Validado el 2026-07-29 con radicados reales (Consejo de Estado, Tribunal Administrativo,
Juzgado Penal del Circuito — todos cubiertos).

## Base URL

```
https://consultaprocesos.ramajudicial.gov.co:448/api/v2
```

⚠️ **Corre en el puerto `:448`, no en el 443 estándar.** Sin el `:448` el servidor
responde `406` o devuelve el SPA en vez del JSON. Enviar siempre `Accept: application/json`.

## Endpoints

### 1. Consultar por número de radicación
```
GET /Procesos/Consulta/NumeroRadicacion?numero={23digitos}&SoloActivos=false&pagina=1
```
Devuelve `procesos[]` con: `idProceso`, `llaveProceso` (radicado), `despacho`,
`departamento`, `fechaProceso`, `fechaUltimaActuacion`, `sujetosProcesales`, `esPrivado`.

### 2. Consultar por nombre / razón social
```
GET /Procesos/Consulta/NombreRazonSocial?...
```
Útil para procesos sin radicado de 23 dígitos.

### 3. Actuaciones de un proceso  (motor de alertas)
```
GET /Proceso/Actuaciones/{idProceso}?pagina=1
```
Devuelve `actuaciones[]` con: `idRegActuacion` (único), `consActuacion` (secuencia),
`fechaActuacion`, `fechaRegistro`, `actuacion` (tipo), `anotacion` (texto), `cant` (total),
`conDocumentos`. 40 registros por página; `paginacion` indica cantidad de páginas.

## Estrategia de detección de cambios (2x/día)

1. Check barato: consultar por radicación y comparar `fechaUltimaActuacion` con lo guardado.
2. Si cambió (o `cant` aumentó): traer `Actuaciones` y detectar las nuevas por `idRegActuacion`.
3. Crear alerta con la `anotacion` de la actuación nueva → notificar.

Esto reduce a la mitad la carga contra el servidor y evita bloqueos.

## Ejemplo de respuesta (consulta por radicación)

```json
{
  "procesos": [{
    "idProceso": 152648932,
    "llaveProceso": "25000234200020180182301",
    "despacho": "DESPACHO 000 - CONSEJO DE ESTADO - SECCIÓN SEGUNDA - BOGOTÁ *",
    "departamento": "BOGOTÁ",
    "fechaUltimaActuacion": "2025-06-13T00:00:00",
    "sujetosProcesales": "Demandante: ... | DEMANDADO: ..."
  }],
  "paginacion": { "cantidadRegistros": 1, "cantidadPaginas": 1 }
}
```
