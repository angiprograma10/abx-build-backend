# MEGA AI — servidor propio de inferencia

Este servicio carga un modelo abierto en hardware GPU administrado por el proyecto. Render sigue funcionando como backend web/orquestador; no debe intentar cargar los pesos del modelo.

## Modelo base de prototipo

- Repositorio: `Qwen/Qwen3.5-4B`
- Licencia publicada en el repositorio: Apache-2.0
- Pesos publicados: aproximadamente 9.34 GB en formato Safetensors.
- El modelo card oficial documenta ejecución con vLLM y SGLang.
- En esta primera etapa se ejecuta un modelo base compartido. Los roles MEGA ya tienen prompts separados, pero **todavía no son adaptadores entrenados**.

Fuente oficial: https://huggingface.co/Qwen/Qwen3.5-4B

## Requisitos previos

1. Un equipo/servidor Linux con GPU NVIDIA compatible con la versión de CUDA/PyTorch de vLLM.
2. Espacio libre suficiente para descargar los pesos y guardar caché.
3. Acceso a red para descargar el modelo la primera vez.
4. Un secreto largo para proteger el endpoint de inferencia.
5. Una URL HTTPS privada o protegida a la que pueda llegar el backend de Render.

No se fija una cantidad mínima de VRAM como garantía: el consumo depende de la GPU, precisión, longitud de contexto, caché KV y versión de vLLM. Empieza con contexto reducido y mide memoria antes de aceptar tráfico.

## Instalar y ejecutar

La tarjeta oficial del modelo documenta el uso de vLLM. Instala una versión de vLLM que incluya soporte Qwen3.5 según sus instrucciones actuales:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install vllm
```

En algunos entornos puede ser necesario seguir la guía de instalación CUDA de vLLM en vez de la instalación genérica. Consulta https://docs.vllm.ai/en/stable/getting_started/installation/

Configura las variables y ejecuta:

```bash
export MEGA_BASE_MODEL="Qwen/Qwen3.5-4B"
export MEGA_INFERENCE_API_KEY="CAMBIA_ESTO_POR_UN_SECRETO_LARGO"
export MEGA_MAX_MODEL_LEN="8192"
bash inference/serve.sh
```

El servidor expone una API compatible con OpenAI en `/v1/chat/completions`, con el modelo servido como `mega-base`.

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

El backend transforma `/v1` en `/v1/chat/completions`. No uses una URL localhost en Render: localhost apuntaría al contenedor de Render, no a tu equipo.

Protege el servidor con HTTPS, firewall o red privada. La autenticación de vLLM por API key no protege todos sus endpoints; la documentación oficial advierte que algunas rutas, como `/invocations`, requieren protección adicional en la red/reverse proxy. No expongas el puerto GPU directamente a Internet sin esa protección.

## Adaptadores especializados posteriores

Cuando exista y se haya evaluado un adaptador LoRA, colócalo en una de estas carpetas:

- `models/mega-build`
- `models/mega-scripting`
- `models/mega-ui`
- `models/mega-fx`
- `models/mega-gameplay`

`serve.sh` los registra si sus carpetas contienen un adaptador PEFT válido. Después cambia en Render el modelo del rol correspondiente, por ejemplo `MEGA_BUILD_MODEL=mega-build`. Mientras no exista un adaptador entrenado, el backend usa `mega-base` y aplica instrucciones específicas por especialista.

No marques un especialista como entrenado hasta que tenga pesos LoRA propios y supere su conjunto de evaluación.

## Estado real

Esta carpeta solo prepara el servidor. No instala una GPU, no despliega un host y no entrena pesos automáticamente. El despliegue depende de proporcionar hardware/hosting GPU y configurar el endpoint privado.
