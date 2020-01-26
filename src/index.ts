import { Commands } from "./commands";
import { makeVimDoctor } from "./embeddedDoctor";
import {
  getJavaHome,
  getJavaOptions,
  checkDottyIde,
  restartServer
} from "metals-languageclient";
import {
  ExecuteClientCommand,
  MetalsInputBox,
  MetalsDidFocus,
  DecorationsRangesDidChange,
  PublishDecorationsParams
} from "./metalsProtocol";
import {
  checkServerVersion,
  trackDownloadProgress,
  toggleLogs,
  wait,
  detectLaunchConfigurationChanges
} from "./utils";
import {
  commands,
  ExtensionContext,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  workspace,
  events,
  FloatFactory
} from "coc.nvim";
import { spawn, ChildProcessPromise } from "promisify-child-process";
import {
  ExecuteCommandRequest,
  Location
} from "vscode-languageserver-protocol";
import * as path from "path";
import { MetalsFeatures } from "./MetalsFeatures";
import DecorationProvider from "./decoration";
import { InputBoxOptions } from "./portedProtocol";
import { TreeViewController } from "./tvp/controller";
import { TreeViewFeature } from "./tvp/feature";
import { TreeViewsManager } from "./tvp/treeviews";

export async function activate(context: ExtensionContext) {
  detectLaunchConfigurationChanges();
  await checkServerVersion();

  getJavaHome(workspace.getConfiguration("metals").get("javaHome"))
    .then(javaHome => fetchAndLaunchMetals(context, javaHome))
    .catch(_ => {
      const message =
        "Unable to find a Java 8 or Java 11 installation on this computer. " +
        "To fix this problem, update the 'Java Home' setting to point to a Java 8 or Java 11 home directory";
      const openSettings = "Open Settings";
      const ignore = "Ignore for now";
      workspace.showQuickpick([openSettings, ignore], message).then(choice => {
        if (choice === 0) {
          workspace.nvim.command(Commands.OPEN_COC_CONFIG, true);
        }
      });
    });
}

function fetchAndLaunchMetals(context: ExtensionContext, javaHome: string) {
  const dottyIde = checkDottyIde(workspace.workspaceFolder?.uri);
  if (dottyIde.enabled) {
    workspace.showMessage(
      `Metals will not start since Dotty is enabled for this workspace. ` +
        `To enable Metals, remove the file ${dottyIde.path} and run ':CocCommand metals.restartServer'`,
      "warning"
    );
    return;
  }

  const javaPath = path.join(javaHome, "bin", "java");
  const coursierPath = path.join(context.extensionPath, "./coursier");

  const config = workspace.getConfiguration("metals");
  const serverVersionConfig: string = config.get<string>("serverVersion");
  const defaultServerVersion = config.inspect<string>("serverVersion")!
    .defaultValue!;
  const serverVersion = serverVersionConfig
    ? serverVersionConfig
    : defaultServerVersion;

  const serverProperties: string[] = workspace
    .getConfiguration("metals")
    .get<string[]>("serverProperties")!;

  const javaOptions = getJavaOptions(workspace.workspaceFolder?.uri);

  const fetchProperties: string[] = serverProperties.filter(
    p => !p.startsWith("-agentlib")
  );

  if (fetchProperties.length > 0) {
    workspace.showMessage(
      `Additional server properties detected: ${fetchProperties.join(", ")}`
    );
  }

  const customRepositories: string = config
    .get<string[]>("customRepositories")!
    .join("|");

  if (customRepositories.indexOf("|") !== -1) {
    workspace.showMessage(
      `Custom repositories detected: ${customRepositories}`
    );
  }

  const customRepositoriesEnv =
    customRepositories.length == 0
      ? {}
      : { COURSIER_REPOSITORIES: customRepositories };

  const fetchProcess: ChildProcessPromise = spawn(
    javaPath,
    javaOptions.concat(fetchProperties).concat([
      "-jar",
      coursierPath,
      "fetch",
      "-p",
      "--ttl",
      // Use infinite ttl to avoid redunant "Checking..." logs when using SNAPSHOT
      // versions. Metals SNAPSHOT releases are effectively immutable since we
      // never publish the same version twice.
      "Inf",
      `org.scalameta:metals_2.12:${serverVersion}`,
      "-r",
      "bintray:scalacenter/releases",
      "-r",
      "sonatype:public",
      "-r",
      "sonatype:snapshots",
      "-p"
    ]),
    {
      env: {
        COURSIER_NO_TERM: "true",
        ...customRepositoriesEnv,
        ...process.env
      }
    }
  );

  trackDownloadProgress(fetchProcess)
    .then(classpath => {
      launchMetals(
        context,
        javaPath,
        classpath,
        serverProperties,
        javaOptions,
        customRepositoriesEnv
      );
    })
    .catch(err => {
      const msg = (() => {
        const proxy =
          `See https://scalaeta.org/metals/docs/editors/vscode.html#http-proxy for instructions ` +
          `if you are using an HTTP proxy.`;
        if (serverVersion === defaultServerVersion) {
          return (
            `Failed to download Metals, make sure you have an internet connection and ` +
            `the Java Home '${javaPath}' is valid. You can configure the Java Home in the settings.` +
            proxy
          );
        } else {
          return (
            `Failed to download Metals, make sure you have an internet connection, ` +
            `the Metals version '${serverVersion}' is correct and the Java Home '${javaPath}' is valid. ` +
            `You can configure the Metals version and Java Home in the settings.` +
            proxy
          );
        }
      })();
      workspace
        .showPrompt(`${err.message}\n ${msg}\n Open Settings?`)
        .then(choice => {
          if (choice) workspace.nvim.command(Commands.OPEN_COC_CONFIG, true);
        });
    });
}

function launchMetals(
  context: ExtensionContext,
  javaPath: string,
  metalsClasspath: string,
  serverProperties: string[],
  javaOptions: string[],
  env: { COURSIER_REPOSITORIES?: string }
) {
  const baseProperties = [
    `-Dmetals.client=coc-metals`,
    `-Dmetals.doctor-format=json`,
    `-Xss4m`,
    `-Xms100m`
  ];
  const mainArgs = ["-classpath", metalsClasspath, "scala.meta.metals.Main"];
  // let user properties override base properties
  const launchArgs = baseProperties
    .concat(javaOptions)
    .concat(serverProperties)
    .concat(mainArgs);

  const serverOptions: ServerOptions = {
    run: { command: javaPath, args: launchArgs, options: { env } },
    debug: { command: javaPath, args: launchArgs, options: { env } }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "scala" }],
    synchronize: {
      configurationSection: "metals"
    },
    revealOutputChannelOn: RevealOutputChannelOn.Never
  };

  const client = new LanguageClient(
    "metals",
    "Metals",
    serverOptions,
    clientOptions
  );

  const features = new MetalsFeatures();
  const treeViewFeature = new TreeViewFeature(client);
  client.registerFeature(features);
  client.registerFeature(treeViewFeature);

  const floatFactory = new FloatFactory(
    workspace.nvim,
    workspace.env,
    false,
    100,
    100,
    true
  );
  const decorationProvider = new DecorationProvider(floatFactory);

  const treeViewsManager = new TreeViewsManager(workspace.nvim, context.logger);
  const treeViewController = new TreeViewController(
    treeViewFeature,
    treeViewsManager
  );
  context.subscriptions.push(
    treeViewFeature,
    treeViewsManager,
    treeViewController
  );

  function registerCommand(command: string, callback: (...args: any[]) => any) {
    context.subscriptions.push(commands.registerCommand(command, callback));
  }

  registerCommand("metals.restartServer", restartServer(client, workspace));

  context.subscriptions.push(client.start());

  client.onReady().then(_ => {
    workspace.showMessage("Metals is ready!");

    const commands = [
      "build-import",
      "build-connect",
      "sources-scan",
      "doctor-run",
      "compile-cascade",
      "compile-cancel"
    ];

    commands.forEach(command => {
      registerCommand("metals." + command, async () => {
        workspace.showMessage("metals" + command);
        client.sendRequest(ExecuteCommandRequest.type, { command });
      });
    });

    registerCommand("metals.logs-toggle", () => {
      toggleLogs();
    });

    if (features.decorationProvider) {
      context.subscriptions.push(
        workspace.registerKeymap(
          ["n"],
          "metals-expand-decoration",
          () => {
            decorationProvider.showHover();
          },
          { sync: false }
        )
      );
    }

    client.onNotification(ExecuteClientCommand.type, async params => {
      switch (params.command) {
        case "metals-goto-location":
          const location =
            params.arguments && (params.arguments[0] as Location);
          if (location) {
            await treeViewsManager.prepareWindowForGoto();
            // It seems this line fixes weird issue with "returned a response with an unknown
            // request id" after executing commands several times.
            await wait(10);
            await workspace.jumpTo(location.uri, location.range.start);
          }
          break;
        case "metals-doctor-run":
          const doctorJson: string = params.arguments && params.arguments[0];
          makeVimDoctor(JSON.parse(doctorJson));
          break;
        case "metals-doctor-reload":
          workspace.nvim.call("coc#util#has_preview").then(preview => {
            if (preview > 0) {
              const doctorJson: string =
                params.arguments && params.arguments[0];
              makeVimDoctor(JSON.parse(doctorJson));
            }
          });
          break;
        case "metals-diagnostics-focus":
          workspace.nvim.command("CocList diagnostics");
          break;
        case "metals-logs-toggle":
          toggleLogs();
          break;
        default:
          workspace.showMessage(`Recieved unknown command: ${params.command}`);
      }
    });

    events.on("BufWinEnter", (bufnr: number) => {
      const currentDocument = workspace.documents.find(
        document => document.bufnr === bufnr
      );
      // For now I'm just checking for scala since both scala and sc files will be marked
      // as scala, and this is only relevant for decorations anyways.
      if (currentDocument && currentDocument.filetype === "scala") {
        client.sendNotification(MetalsDidFocus.type, currentDocument.uri);
      }
    });

    client.onRequest(
      MetalsInputBox.type,
      async (options: InputBoxOptions, requestToken) => {
        const response = await workspace.callAsync<string>("input", [
          `${options.prompt} `,
          options.value
        ]);
        if (response === undefined) {
          return { cancelled: true };
        } else {
          workspace.showMessage(response);
          return { value: response };
        }
      }
    );

    if (features.decorationProvider) {
      client.onNotification(
        DecorationsRangesDidChange.type,
        (params: PublishDecorationsParams) => {
          if (workspace.uri && workspace.uri === params.uri) {
            decorationProvider.setDecorations(params);
          }
        }
      );

      events.on("BufWinLeave", (bufnr: number) => {
        const previousDocument = workspace.documents.find(
          document => document.bufnr === bufnr
        );
        if (
          previousDocument &&
          previousDocument.uri.endsWith(".worksheet.sc")
        ) {
          decorationProvider.clearDecorations(bufnr);
        }
      });
    }
  });
}
