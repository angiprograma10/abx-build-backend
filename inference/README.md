# MEGA AI — servidor propio de inferencia

MEGA utiliza **OpenAI gpt-oss-20b**, un modelo de pesos abiertos que se ejecuta en infraestructura administrada por el proyecto. Los pesos no se sirven desde ChatGPT ni desde la API de OpenAI: el servidor de inferencia lo controla MEGA.

## Modelo base

- Identificador: `openai/gpt-oss-20b`
- Licencia: Apache 2.0, sujeta a la política de uso de gpt-oss.
- Tamaño: 21B parámetros totales y 3.6B activos por token.
- Formato publicado: MXFP4.
- Memoria de GPU de referencia: alrededor de 16 GB para inferencia con MXFP4; el consumo real depende del contexto, caché, runtime y concurrencia.
- Contexto máximo anunciado: 131,072 tokens; MEGA comienza con 8,192 para controlar memoria y latencia.

Fuentes oficiales:
- https://developers.openai.com/api/docs/models/gpt-oss-20b
- https://github.com/openai/gpt-oss
- https://developers.openai.com/cookbook/articles/gpt-oss/run-vllm

## Arquitectura MEGA

Render permanece como backend web y orquestador. No carga los pesos del modelo. El servidor vLLM ejecuta `openai/gpt-oss-20b` y expone una API compatible con OpenAI en `/v1/chat/completions`.

Los roles MEGA (DIRECTOR, CHAT, BUILD, SCRIPTING, UI, VFX, GAMEPLAY y QA) usan instrucciones especializadas sobre el modelo base. **Los roles todavía no son modelos independientes entrenados**: cada uno necesita un conjunto de datos propio, entrenamiento LoRA compatible, evaluación y despliegue de sus adaptadores.

## Modo propio obligatorio

El backend exige inferencia alojada por MEGA de forma predeterminada. Si `MEGA_INFERENCE_URL` no está configurada, no recurre silenciosamente a otro proveedor.

## Requisitos previos

1. Un host Linux con GPU compatible con la versión de vLLM y CUDA instalada.
2. Como referencia inicial, una GPU con al menos 16 GB de memoria para el modelo cuantizado; deja margen adicional para caché, contexto y solicitudes simultáneas.
3. Espacio libre para descargar y almacenar los pesos.
4. Un secreto largo para proteger el endpoint.
5. Una URL HTTPS privada o protegida a la que pueda llegar el backend de Render.

La receta actual de vLLM para gpt-oss-20b documenta vLLM 0.10.1 o posterior y varios tipos de GPU compatibles. Verifica la matriz vigente antes de elegir hardware o una imagen de contenedor:
https://recipes.vllm.ai/openai/gpt-oss-20b

## Instalar y ejecutar

Sigue la instalación oficial de vLLM para el sistema operativo, GPU y versión de CUDA del host:
https://docs.vllm.ai/en/stable/getting_started/installation/

Después ejecuta:

```bash
export MEGA_BASE_MODEL="openai/gpt-oss-20b"
export MEGA_INFERENCE_API_KEY="CAMBIA_ESTO_POR_UN_SECRETO_LARGO"
export MEGA_MAX_MODEL_LEN="8192"
bash inference/serve.sh
```

El primer inicio descarga los pesos. El servidor registra el modelo como `mega-base` y expone `/v1/chat/completions`.

Prueba local:

```bash
curl http://127.0.0.1:8000/v1/models \
  -H "Authorization: Bearer $MEGA_INFERENCE_API_KEY"
```

## Conectar Render

En las variables privadas del servicio backend de Render:

- `MEGA_INFERENCE_URL=https://TU-HOST-PRIVADO/v1`
- `MEGA_INFERENCE_API_KEY=el-mismo-secreto-configurado-en-vLLM`
- `MEGA_BASE_MODEL=mega-base`

El backend transforma `/v1` en `/v1/chat/completions`. No uses una URL localhost en Render: localhost apuntaría al contenedor de Render, no al host de inferencia.

Protege el servidor con HTTPS, firewall o red privada. No expongas el puerto de inferencia directamente a Internet sin una capa de protección.

## Adaptadores especializados posteriores

Cuando exista y se haya evaluado un adaptador LoRA compatible con esta base, colócalo en una de estas carpetas:

- `models/mega-director`
- `models/mega-chat`
- `models/mega-build`
- `models/mega-scripting`
- `models/mega-ui`
- `models/mega-fx`
- `models/mega-gameplay`
- `models/mega-qa`

`serve.sh` los registra si sus carpetas contienen adaptadores válidos para la versión de vLLM y la arquitectura de gpt-oss. No cambies un rol a un adaptador hasta verificar su compatibilidad y pasar el benchmark de MEGA.

## Estado real

El repositorio ahora selecciona gpt-oss-20b como modelo base predeterminado y prepara el comando de servicio. **Esto no significa que el modelo ya esté descargado, alojado, entrenado ni conectado a Render.** Todavía hace falta un host compatible, desplegar vLLM, probar la API y configurar la URL privada en Render.
