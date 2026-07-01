FROM continuumio/miniconda3:latest

# Ensure python output is unbuffered
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Copy environment definition and install dependencies
COPY environment.yml /app/environment.yml
RUN conda env create -f environment.yml && conda clean -afy

# Activate the environment in subsequent RUN commands
SHELL ["conda", "run", "-n", "sjfu-catalog", "/bin/bash", "-c"]

# Copy source code
COPY . /app

# Ensure entrypoint uses conda env
ENTRYPOINT ["conda", "run", "--no-capture-output", "-n", "sjfu-catalog"]

# Start uvicorn server mapping to Cloud Run expected PORT variable
CMD ["sh", "-c", "uvicorn services.swarm.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
