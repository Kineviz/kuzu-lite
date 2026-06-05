

const fs = require("fs");
const path = require("path");


/** 
 * Install packages
 */

const installPackage = (packageName, group = 'dev') => {

  console.log(
    `Install package ${packageName}...`
  );
  const childProcess = require("child_process");
  childProcess.execSync(`npm install ${packageName} --save-dev`, {
    cwd: rootDir,
    stdio: "inherit",
  });

}


/**
 * Copies files from the 'node_modules/kuzu' directory to the current directory.
 * Excludes specific directories ('kuzu-source', 'node_modules') and specific files ('kuzujs.node', 'package.json').
 */

const copyDir = (src, dest, excludeEntries = []) => {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!excludeEntries.includes(entry.name)) {
        copyDir(srcPath, destPath);
      }
    } else if (!excludeEntries.includes(entry.name)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`Copied: ${srcPath} -> ${destPath}`);
    }
  }
};

/**
 * Deletes all files and directories in the current directory
 * except for 'copy.js', 'package.json', and the 'node_modules' directory.
 */
const deleteFiles = (directory, excludeEntries = []) => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    // Skip if the entry is in the exclusion list
    if (excludeEntries.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recursively delete directory contents then the directory itself
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`Deleted directory: ${fullPath}`);
    } else {
      // Delete file
      fs.unlinkSync(fullPath);
      console.log(`Deleted file: ${fullPath}`);
    }
  }
};

const npmPublish = (package) => {
  console.log(
    `Publishing package ${package.name}(${package.version})... to npm`
  );
  const npmrcPath = path.join(rootDir, ".npmrc");
  fs.writeFileSync(
    npmrcPath,
    `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`,
    { encoding: "utf-8" }
  );

  const childProcess = require("child_process");
  try {
    childProcess.execSync("npm publish --access public --registry https://registry.npmjs.org", {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("npm publish failed:", err);
  }
};

const asyncVersion = () => {
  // Copy version from node_modules/kuzu/package.json to ./package.json
  const kuzuPackageJsonPath = path.join(srcDir, "package.json");
  const projectPackageJsonPath = path.join(rootDir, "package.json");

  if (
    !fs.existsSync(kuzuPackageJsonPath) ||
    !fs.existsSync(projectPackageJsonPath)
  ) {
    console.error("the package.json file not found");
  }

  let kuzuPackageJson = {};
  let projectPackageJson = {};
  try {
    // Read both package.json files
    kuzuPackageJson = JSON.parse(fs.readFileSync(kuzuPackageJsonPath, "utf8"));
    projectPackageJson = JSON.parse(
      fs.readFileSync(projectPackageJsonPath, "utf8")
    );
  } catch (error) {
    console.error("Can not parse the package.json version:", error);
  }

  if (projectPackageJson.version != kuzuPackageJson.version) {
    projectPackageJson.version = kuzuPackageJson.version;
    projectPackageJson.devDependencies.kuzu = kuzuPackageJson.version;
    // Write the updated package.json back
    fs.writeFileSync(
      projectPackageJsonPath,
      JSON.stringify(projectPackageJson, null, 2)
    );
    console.log(`Updated package.json version to ${kuzuPackageJson.version}`);
    npmPublish(projectPackageJson);
  } else {
    console.log(
      `Package.json version is already up to date: ${kuzuPackageJson.version}`
    );
  }
};

const rootDir = path.join(__dirname, "..");

// already install kuzu with docker or action
// installPackage("kuzu");

// Delete files before copying new ones
deleteFiles(rootDir, [
  "package.json",
  "util",
  "node_modules",
  "README.md",
  "test",
  ".git",
  ".vscode",
  ".gitignore",
  ".github",
  ".dockerignore",
  "Dockerfile",
  ".npmignore"
]);

const srcDir = path.join(rootDir, "node_modules", "kuzu");
const destDir = path.join(rootDir);

if (fs.existsSync(srcDir)) {
  //the window version do not support electron, so need build byself
  copyDir(srcDir, destDir, [
    "kuzu-source",
    "node_modules",
    "kuzujs.node",
    "package.json",
    "install.js",
    "README.md",
    "test",
    ".gitignore",
    ".github",
    ".dockerignore",
    ".npmignore",
    "Dockerfile",
    "prebuilt/kuzujs-win32-x64.node"
  ]);
  console.log("Copying completed!");
} else {
  console.error("Source directory not found:", srcDir);
}

asyncVersion();
