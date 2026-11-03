# MEGA AI — datos y entrenamiento de especialistas

Cada especialidad tendrá su propio conjunto de datos y su propio adaptador LoRA:

- `mega-build`
- `mega-scripting`
- `mega-ui`
- `mega-fx`
- `mega-gameplay`
- Opcionalmente `mega-director` y `mega-qa`

## No mezclar roles

Un ejemplo de BUILD debe enseñar diseño espacial y acciones de construcción. Un ejemplo de SCRIPTING debe enseñar Luau, eventos, arquitectura cliente/servidor y validación. UI debe enseñar árboles CREATE_TREE, layout y contratos de interacción. FX debe enseñar propiedades y relaciones visuales. GAMEPLAY debe enseñar mecánicas y estados.

Los conjuntos pueden compartir ejemplos de proyectos completos como contexto, pero cada ejemplo debe marcar claramente qué especialista está aprendiendo.

## Formato

Un archivo JSONL contiene un objeto JSON por línea con:

- `specialist`: identificador del especialista.
- `messages`: mensajes de chat con roles `system`, `user` o `assistant`.
- La salida del asistente debe respetar el contrato del plugin: JSON con `reply` y `actions`.

Consulta `dataset.schema.json` para el formato mínimo.

## Calidad y procedencia

- Utiliza código original, ejemplos propios y documentación reutilizable conforme a sus licencias.
- Registra fuente, licencia, autoría y fecha de cada conjunto externo que se incorpore.
- No incluyas secretos, tokens, datos personales, código privado ni assets sin permiso.
- Revisa manualmente los ejemplos antes de entrenar; descarta respuestas con APIs inventadas, rutas incorrectas o código que no pueda validarse.
- Separa entrenamiento, validación y prueba por proyecto/origen para evitar que ejemplos casi idénticos aparezcan en más de una partición.
- Conserva un conjunto de evaluación fijo que no se use para entrenar.

## Primer piloto

Empieza con un pequeño lote balanceado de ejemplos revisados por especialidad. La cantidad no garantiza calidad: el objetivo del piloto es comprobar que el formato, el entrenamiento y las evaluaciones funcionan. Aumenta los datos solo cuando las pruebas muestran mejoras medibles.

## Entrenamiento

Los adaptadores se entrenarán por separado sobre el mismo modelo base aprobado en `inference/README.md`, usando PEFT/LoRA y una versión compatible de Transformers con Qwen3.5. No se debe llamar “modelo especializado” a una etiqueta de frontend o a un prompt distinto: debe existir un adaptador entrenado, versionado y evaluado.

Cada adaptador debe conservar:
- Identificador y versión de modelo base.
- Commit/hash del dataset.
- Configuración de entrenamiento.
- Métricas de validación.
- Informe de regresiones.
- Ruta/versión del adaptador exportado.

La promoción a producción debe ser manual después de aprobar el benchmark de Roblox Studio.
