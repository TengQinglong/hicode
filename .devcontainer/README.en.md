# Ubuntu development container

[简体中文](README.md)

Develop and debug HiCode on Ubuntu 24.04 from macOS, or run separate test projects. Validated on Apple Silicon with Colima. This environment is optional; normal HiCode usage does not require a container.

## First launch

Install Colima, the Docker CLI, Compose, and Buildx with Homebrew:

```sh
brew install colima docker docker-compose docker-buildx
```

Follow `brew info docker-compose docker-buildx` to configure Docker plugins, then confirm `docker compose version` and `docker buildx version` work.

From the HiCode repository root, create the dedicated VM and start the container:

```sh
colima start hicode --vm-type vz --cpu 4 --memory 6 --disk 40 \
  --mount "$(pwd):w" --mount-type virtiofs --ssh-agent=false --ssh-config=false
bash .devcontainer/linux.sh start
bash .devcontainer/linux.sh
```

The first launch builds the image and installs project dependencies. Later launches reuse the image, dependencies, and volumes. `start` ensures the existing environment is running without rebuilding it; stopped containers are restarted. Type `exit` to return to the Mac shell; the container stays running.

For a shorter command:

```sh
bash .devcontainer/linux.sh install-command
```

This installs `~/.local/bin/hicode-linux`. If that directory is not in PATH, add `export PATH="$HOME/.local/bin:$PATH"` to your shell configuration and reopen the terminal. Then run `hicode-linux` from any directory. Reinstall the launcher after moving the checkout.

## Open in VS Code

Install Microsoft's **Dev Containers** extension and complete the first launch above.

1. Run `docker context use colima-hicode` so VS Code uses this VM.
2. Open the HiCode checkout, press `⌘⇧P`, and select **Dev Containers: Reopen in Container**.
3. The new window opens `/workspaces/lab`. Alternatively, use **Attach to Running Container…**, select `hicode-linux-dev-1`, and open that directory.

The first connection downloads the server matching your VS Code version; subsequent connections reuse it. Closing VS Code does not stop the container.

## File locations

| Container path | Purpose |
| --- | --- |
| `/workspaces/lab` | Separate test projects in the `lab` volume, outside the HiCode checkout |
| `/workspaces/hicode` | Your host checkout; edits are shared with macOS |
| `/workspaces/hicode/node_modules` | Linux dependency volume, separate from Mac dependencies |
| `/home/node` | Linux user home, including model configuration, logs, and VS Code Server |

Create a project under `/workspaces/lab` and run `hicode`. Configure a model on first use; Mac API keys are not copied automatically. The container's `hicode` command runs the mounted source, so restarting HiCode picks up code changes.

For development, run `cd /workspaces/hicode && bun run verify`. After dependency changes, run `bun install --frozen-lockfile` there.

The container shares the **Colima VM's** network, and Colima forwards listening ports to macOS. For example, a server on `127.0.0.1:5173` is reachable at that address on your Mac. Ports must be available on both sides; binding `0.0.0.0` may expose a service to the LAN. Services inside HiCode's restricted network do not use this forwarding path.

## Optional proxy

**Direct networking is the default; no `.env` is required.** Only copy the template when builds or container traffic require a proxy:

```sh
cp .devcontainer/.env.example .devcontainer/.env
```

Set `HICODE_CONTAINER_PROXY` to an address reachable by the container and build process. Do not copy another person's IP or port: `127.0.0.1` inside the container refers to the VM, not your Mac. A proxy is not a HiCode requirement.

- `.env.example` contains an empty value and can be committed; the real `.env` is ignored by Git.
- Compose reads this configuration for builds and runtime. The launcher never executes it as a shell script.
- Configure host tools' HTTP(S) proxies separately if needed. Image pulls also depend on Docker engine networking.
- Proxy changes do not update existing containers. Save work and stop active tasks before running `hicode-linux rebuild` to apply them to the development container.

For `EAI_AGAIN`, inspect `/etc/resolv.conf` in the VM and container. Missing DNS addresses or broken symlinks are environment issues to fix in the VM configuration; HiCode does not automatically change system DNS.

## Updating and stopping

```sh
hicode-linux                 # Start if necessary, then enter
hicode-linux start           # Start without entering
hicode-linux status          # Show container status
hicode-linux stop            # Stop while retaining data
hicode-linux rebuild         # Rebuild and recreate; interrupts container processes
colima stop hicode           # Stop the entire VM
```

Put permanent system dependencies in `Dockerfile`. Packages installed interactively can disappear when the container is recreated. Do not use `docker compose down -v` or delete the VM for a routine update; these delete stored data.

## Configuration and isolation

`Dockerfile` defines Ubuntu, Bun, Node, and system packages. `compose.yaml` defines builds, mounts, and services; `devcontainer.json` configures VS Code; `linux.sh` manages the local launcher.

To test HiCode's Bubblewrap sandbox inside Docker, the container uses a dedicated AppArmor profile, `seccomp=unconfined`, and `systempaths=unconfined`. The script loads the profile only into the `hicode` VM. It does not disable global VM protection, use privileged mode, or mount the Docker socket. This is a trusted development environment, not an isolation template for untrusted workloads.

The default targets Colima. For another Docker engine, set `HICODE_DOCKER_CONTEXT` and prepare compatible AppArmor and nested namespace policies yourself; changing the context alone does not guarantee compatibility.

The optional `mcp-test` profile provides a local HTTP MCP example and is not started by default:

```sh
docker --context colima-hicode compose -f .devcontainer/compose.yaml --profile mcp-test up -d mcp-http-demo
```

Its address is `http://127.0.0.1:8787/mcp`; source lives in `tooling/examples/mcp/http-demo.ts`. Install Skills, browser dependencies, and your own MCP configuration as needed. Personal test data is not preinstalled.

## Evaluation engine

`bash .devcontainer/linux.sh engine-start` starts the Docker engine and loads the AppArmor policy without starting the development container or building evaluation images. [HiCode Eval](../hicode-eval/README.en.md) owns the clean base, dependency images and per-attempt containers.
