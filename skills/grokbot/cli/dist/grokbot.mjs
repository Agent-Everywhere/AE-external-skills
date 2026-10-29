#!/usr/bin/env node
import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/commander/lib/error.js
var require_error = __commonJS({
  "node_modules/commander/lib/error.js"(exports) {
    var CommanderError2 = class extends Error {
      /**
       * Constructs the CommanderError class
       * @param {number} exitCode suggested exit code which could be used with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       */
      constructor(exitCode, code, message) {
        super(message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
        this.code = code;
        this.exitCode = exitCode;
        this.nestedError = void 0;
      }
    };
    var InvalidArgumentError2 = class extends CommanderError2 {
      /**
       * Constructs the InvalidArgumentError class
       * @param {string} [message] explanation of why argument is invalid
       */
      constructor(message) {
        super(1, "commander.invalidArgument", message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
      }
    };
    exports.CommanderError = CommanderError2;
    exports.InvalidArgumentError = InvalidArgumentError2;
  }
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS({
  "node_modules/commander/lib/argument.js"(exports) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Argument2 = class {
      /**
       * Initialize a new command argument with the given name and description.
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @param {string} name
       * @param {string} [description]
       */
      constructor(name, description) {
        this.description = description || "";
        this.variadic = false;
        this.parseArg = void 0;
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.argChoices = void 0;
        switch (name[0]) {
          case "<":
            this.required = true;
            this._name = name.slice(1, -1);
            break;
          case "[":
            this.required = false;
            this._name = name.slice(1, -1);
            break;
          default:
            this.required = true;
            this._name = name;
            break;
        }
        if (this._name.length > 3 && this._name.slice(-3) === "...") {
          this.variadic = true;
          this._name = this._name.slice(0, -3);
        }
      }
      /**
       * Return argument name.
       *
       * @return {string}
       */
      name() {
        return this._name;
      }
      /**
       * @package
       */
      _concatValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        return previous.concat(value);
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Argument}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Set the custom handler for processing CLI command arguments into argument values.
       *
       * @param {Function} [fn]
       * @return {Argument}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Only allow argument value to be one of choices.
       *
       * @param {string[]} values
       * @return {Argument}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._concatValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Make argument required.
       *
       * @returns {Argument}
       */
      argRequired() {
        this.required = true;
        return this;
      }
      /**
       * Make argument optional.
       *
       * @returns {Argument}
       */
      argOptional() {
        this.required = false;
        return this;
      }
    };
    function humanReadableArgName(arg) {
      const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
      return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
    }
    exports.Argument = Argument2;
    exports.humanReadableArgName = humanReadableArgName;
  }
});

// node_modules/commander/lib/help.js
var require_help = __commonJS({
  "node_modules/commander/lib/help.js"(exports) {
    var { humanReadableArgName } = require_argument();
    var Help2 = class {
      constructor() {
        this.helpWidth = void 0;
        this.minWidthToWrap = 40;
        this.sortSubcommands = false;
        this.sortOptions = false;
        this.showGlobalOptions = false;
      }
      /**
       * prepareContext is called by Commander after applying overrides from `Command.configureHelp()`
       * and just before calling `formatHelp()`.
       *
       * Commander just uses the helpWidth and the rest is provided for optional use by more complex subclasses.
       *
       * @param {{ error?: boolean, helpWidth?: number, outputHasColors?: boolean }} contextOptions
       */
      prepareContext(contextOptions) {
        this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
      }
      /**
       * Get an array of the visible subcommands. Includes a placeholder for the implicit help command, if there is one.
       *
       * @param {Command} cmd
       * @returns {Command[]}
       */
      visibleCommands(cmd) {
        const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
        const helpCommand = cmd._getHelpCommand();
        if (helpCommand && !helpCommand._hidden) {
          visibleCommands.push(helpCommand);
        }
        if (this.sortSubcommands) {
          visibleCommands.sort((a, b) => {
            return a.name().localeCompare(b.name());
          });
        }
        return visibleCommands;
      }
      /**
       * Compare options for sort.
       *
       * @param {Option} a
       * @param {Option} b
       * @returns {number}
       */
      compareOptions(a, b) {
        const getSortKey = (option) => {
          return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
        };
        return getSortKey(a).localeCompare(getSortKey(b));
      }
      /**
       * Get an array of the visible options. Includes a placeholder for the implicit help option, if there is one.
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleOptions(cmd) {
        const visibleOptions = cmd.options.filter((option) => !option.hidden);
        const helpOption = cmd._getHelpOption();
        if (helpOption && !helpOption.hidden) {
          const removeShort = helpOption.short && cmd._findOption(helpOption.short);
          const removeLong = helpOption.long && cmd._findOption(helpOption.long);
          if (!removeShort && !removeLong) {
            visibleOptions.push(helpOption);
          } else if (helpOption.long && !removeLong) {
            visibleOptions.push(
              cmd.createOption(helpOption.long, helpOption.description)
            );
          } else if (helpOption.short && !removeShort) {
            visibleOptions.push(
              cmd.createOption(helpOption.short, helpOption.description)
            );
          }
        }
        if (this.sortOptions) {
          visibleOptions.sort(this.compareOptions);
        }
        return visibleOptions;
      }
      /**
       * Get an array of the visible global options. (Not including help.)
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleGlobalOptions(cmd) {
        if (!this.showGlobalOptions) return [];
        const globalOptions = [];
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          const visibleOptions = ancestorCmd.options.filter(
            (option) => !option.hidden
          );
          globalOptions.push(...visibleOptions);
        }
        if (this.sortOptions) {
          globalOptions.sort(this.compareOptions);
        }
        return globalOptions;
      }
      /**
       * Get an array of the arguments if any have a description.
       *
       * @param {Command} cmd
       * @returns {Argument[]}
       */
      visibleArguments(cmd) {
        if (cmd._argsDescription) {
          cmd.registeredArguments.forEach((argument) => {
            argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
          });
        }
        if (cmd.registeredArguments.find((argument) => argument.description)) {
          return cmd.registeredArguments;
        }
        return [];
      }
      /**
       * Get the command term to show in the list of subcommands.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandTerm(cmd) {
        const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
        return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + // simplistic check for non-help option
        (args ? " " + args : "");
      }
      /**
       * Get the option term to show in the list of options.
       *
       * @param {Option} option
       * @returns {string}
       */
      optionTerm(option) {
        return option.flags;
      }
      /**
       * Get the argument term to show in the list of arguments.
       *
       * @param {Argument} argument
       * @returns {string}
       */
      argumentTerm(argument) {
        return argument.name();
      }
      /**
       * Get the longest command term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestSubcommandTermLength(cmd, helper) {
        return helper.visibleCommands(cmd).reduce((max, command) => {
          return Math.max(
            max,
            this.displayWidth(
              helper.styleSubcommandTerm(helper.subcommandTerm(command))
            )
          );
        }, 0);
      }
      /**
       * Get the longest option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestOptionTermLength(cmd, helper) {
        return helper.visibleOptions(cmd).reduce((max, option) => {
          return Math.max(
            max,
            this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
          );
        }, 0);
      }
      /**
       * Get the longest global option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestGlobalOptionTermLength(cmd, helper) {
        return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
          return Math.max(
            max,
            this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
          );
        }, 0);
      }
      /**
       * Get the longest argument term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestArgumentTermLength(cmd, helper) {
        return helper.visibleArguments(cmd).reduce((max, argument) => {
          return Math.max(
            max,
            this.displayWidth(
              helper.styleArgumentTerm(helper.argumentTerm(argument))
            )
          );
        }, 0);
      }
      /**
       * Get the command usage to be displayed at the top of the built-in help.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandUsage(cmd) {
        let cmdName = cmd._name;
        if (cmd._aliases[0]) {
          cmdName = cmdName + "|" + cmd._aliases[0];
        }
        let ancestorCmdNames = "";
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
        }
        return ancestorCmdNames + cmdName + " " + cmd.usage();
      }
      /**
       * Get the description for the command.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandDescription(cmd) {
        return cmd.description();
      }
      /**
       * Get the subcommand summary to show in the list of subcommands.
       * (Fallback to description for backwards compatibility.)
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandDescription(cmd) {
        return cmd.summary() || cmd.description();
      }
      /**
       * Get the option description to show in the list of options.
       *
       * @param {Option} option
       * @return {string}
       */
      optionDescription(option) {
        const extraInfo = [];
        if (option.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (option.defaultValue !== void 0) {
          const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
          if (showDefault) {
            extraInfo.push(
              `default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`
            );
          }
        }
        if (option.presetArg !== void 0 && option.optional) {
          extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
        }
        if (option.envVar !== void 0) {
          extraInfo.push(`env: ${option.envVar}`);
        }
        if (extraInfo.length > 0) {
          return `${option.description} (${extraInfo.join(", ")})`;
        }
        return option.description;
      }
      /**
       * Get the argument description to show in the list of arguments.
       *
       * @param {Argument} argument
       * @return {string}
       */
      argumentDescription(argument) {
        const extraInfo = [];
        if (argument.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (argument.defaultValue !== void 0) {
          extraInfo.push(
            `default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`
          );
        }
        if (extraInfo.length > 0) {
          const extraDescription = `(${extraInfo.join(", ")})`;
          if (argument.description) {
            return `${argument.description} ${extraDescription}`;
          }
          return extraDescription;
        }
        return argument.description;
      }
      /**
       * Generate the built-in help text.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {string}
       */
      formatHelp(cmd, helper) {
        const termWidth = helper.padWidth(cmd, helper);
        const helpWidth = helper.helpWidth ?? 80;
        function callFormatItem(term, description) {
          return helper.formatItem(term, termWidth, description, helper);
        }
        let output = [
          `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
          ""
        ];
        const commandDescription = helper.commandDescription(cmd);
        if (commandDescription.length > 0) {
          output = output.concat([
            helper.boxWrap(
              helper.styleCommandDescription(commandDescription),
              helpWidth
            ),
            ""
          ]);
        }
        const argumentList = helper.visibleArguments(cmd).map((argument) => {
          return callFormatItem(
            helper.styleArgumentTerm(helper.argumentTerm(argument)),
            helper.styleArgumentDescription(helper.argumentDescription(argument))
          );
        });
        if (argumentList.length > 0) {
          output = output.concat([
            helper.styleTitle("Arguments:"),
            ...argumentList,
            ""
          ]);
        }
        const optionList = helper.visibleOptions(cmd).map((option) => {
          return callFormatItem(
            helper.styleOptionTerm(helper.optionTerm(option)),
            helper.styleOptionDescription(helper.optionDescription(option))
          );
        });
        if (optionList.length > 0) {
          output = output.concat([
            helper.styleTitle("Options:"),
            ...optionList,
            ""
          ]);
        }
        if (helper.showGlobalOptions) {
          const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
            return callFormatItem(
              helper.styleOptionTerm(helper.optionTerm(option)),
              helper.styleOptionDescription(helper.optionDescription(option))
            );
          });
          if (globalOptionList.length > 0) {
            output = output.concat([
              helper.styleTitle("Global Options:"),
              ...globalOptionList,
              ""
            ]);
          }
        }
        const commandList = helper.visibleCommands(cmd).map((cmd2) => {
          return callFormatItem(
            helper.styleSubcommandTerm(helper.subcommandTerm(cmd2)),
            helper.styleSubcommandDescription(helper.subcommandDescription(cmd2))
          );
        });
        if (commandList.length > 0) {
          output = output.concat([
            helper.styleTitle("Commands:"),
            ...commandList,
            ""
          ]);
        }
        return output.join("\n");
      }
      /**
       * Return display width of string, ignoring ANSI escape sequences. Used in padding and wrapping calculations.
       *
       * @param {string} str
       * @returns {number}
       */
      displayWidth(str) {
        return stripColor(str).length;
      }
      /**
       * Style the title for displaying in the help. Called with 'Usage:', 'Options:', etc.
       *
       * @param {string} str
       * @returns {string}
       */
      styleTitle(str) {
        return str;
      }
      styleUsage(str) {
        return str.split(" ").map((word) => {
          if (word === "[options]") return this.styleOptionText(word);
          if (word === "[command]") return this.styleSubcommandText(word);
          if (word[0] === "[" || word[0] === "<")
            return this.styleArgumentText(word);
          return this.styleCommandText(word);
        }).join(" ");
      }
      styleCommandDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleOptionDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleSubcommandDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleArgumentDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleDescriptionText(str) {
        return str;
      }
      styleOptionTerm(str) {
        return this.styleOptionText(str);
      }
      styleSubcommandTerm(str) {
        return str.split(" ").map((word) => {
          if (word === "[options]") return this.styleOptionText(word);
          if (word[0] === "[" || word[0] === "<")
            return this.styleArgumentText(word);
          return this.styleSubcommandText(word);
        }).join(" ");
      }
      styleArgumentTerm(str) {
        return this.styleArgumentText(str);
      }
      styleOptionText(str) {
        return str;
      }
      styleArgumentText(str) {
        return str;
      }
      styleSubcommandText(str) {
        return str;
      }
      styleCommandText(str) {
        return str;
      }
      /**
       * Calculate the pad width from the maximum term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      padWidth(cmd, helper) {
        return Math.max(
          helper.longestOptionTermLength(cmd, helper),
          helper.longestGlobalOptionTermLength(cmd, helper),
          helper.longestSubcommandTermLength(cmd, helper),
          helper.longestArgumentTermLength(cmd, helper)
        );
      }
      /**
       * Detect manually wrapped and indented strings by checking for line break followed by whitespace.
       *
       * @param {string} str
       * @returns {boolean}
       */
      preformatted(str) {
        return /\n[^\S\r\n]/.test(str);
      }
      /**
       * Format the "item", which consists of a term and description. Pad the term and wrap the description, indenting the following lines.
       *
       * So "TTT", 5, "DDD DDDD DD DDD" might be formatted for this.helpWidth=17 like so:
       *   TTT  DDD DDDD
       *        DD DDD
       *
       * @param {string} term
       * @param {number} termWidth
       * @param {string} description
       * @param {Help} helper
       * @returns {string}
       */
      formatItem(term, termWidth, description, helper) {
        const itemIndent = 2;
        const itemIndentStr = " ".repeat(itemIndent);
        if (!description) return itemIndentStr + term;
        const paddedTerm = term.padEnd(
          termWidth + term.length - helper.displayWidth(term)
        );
        const spacerWidth = 2;
        const helpWidth = this.helpWidth ?? 80;
        const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
        let formattedDescription;
        if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
          formattedDescription = description;
        } else {
          const wrappedDescription = helper.boxWrap(description, remainingWidth);
          formattedDescription = wrappedDescription.replace(
            /\n/g,
            "\n" + " ".repeat(termWidth + spacerWidth)
          );
        }
        return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
      }
      /**
       * Wrap a string at whitespace, preserving existing line breaks.
       * Wrapping is skipped if the width is less than `minWidthToWrap`.
       *
       * @param {string} str
       * @param {number} width
       * @returns {string}
       */
      boxWrap(str, width) {
        if (width < this.minWidthToWrap) return str;
        const rawLines = str.split(/\r\n|\n/);
        const chunkPattern = /[\s]*[^\s]+/g;
        const wrappedLines = [];
        rawLines.forEach((line) => {
          const chunks = line.match(chunkPattern);
          if (chunks === null) {
            wrappedLines.push("");
            return;
          }
          let sumChunks = [chunks.shift()];
          let sumWidth = this.displayWidth(sumChunks[0]);
          chunks.forEach((chunk) => {
            const visibleWidth = this.displayWidth(chunk);
            if (sumWidth + visibleWidth <= width) {
              sumChunks.push(chunk);
              sumWidth += visibleWidth;
              return;
            }
            wrappedLines.push(sumChunks.join(""));
            const nextChunk = chunk.trimStart();
            sumChunks = [nextChunk];
            sumWidth = this.displayWidth(nextChunk);
          });
          wrappedLines.push(sumChunks.join(""));
        });
        return wrappedLines.join("\n");
      }
    };
    function stripColor(str) {
      const sgrPattern = /\x1b\[\d*(;\d*)*m/g;
      return str.replace(sgrPattern, "");
    }
    exports.Help = Help2;
    exports.stripColor = stripColor;
  }
});

// node_modules/commander/lib/option.js
var require_option = __commonJS({
  "node_modules/commander/lib/option.js"(exports) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Option2 = class {
      /**
       * Initialize a new `Option` with the given `flags` and `description`.
       *
       * @param {string} flags
       * @param {string} [description]
       */
      constructor(flags, description) {
        this.flags = flags;
        this.description = description || "";
        this.required = flags.includes("<");
        this.optional = flags.includes("[");
        this.variadic = /\w\.\.\.[>\]]$/.test(flags);
        this.mandatory = false;
        const optionFlags = splitOptionFlags(flags);
        this.short = optionFlags.shortFlag;
        this.long = optionFlags.longFlag;
        this.negate = false;
        if (this.long) {
          this.negate = this.long.startsWith("--no-");
        }
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.presetArg = void 0;
        this.envVar = void 0;
        this.parseArg = void 0;
        this.hidden = false;
        this.argChoices = void 0;
        this.conflictsWith = [];
        this.implied = void 0;
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Option}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Preset to use when option used without option-argument, especially optional but also boolean and negated.
       * The custom processing (parseArg) is called.
       *
       * @example
       * new Option('--color').default('GREYSCALE').preset('RGB');
       * new Option('--donate [amount]').preset('20').argParser(parseFloat);
       *
       * @param {*} arg
       * @return {Option}
       */
      preset(arg) {
        this.presetArg = arg;
        return this;
      }
      /**
       * Add option name(s) that conflict with this option.
       * An error will be displayed if conflicting options are found during parsing.
       *
       * @example
       * new Option('--rgb').conflicts('cmyk');
       * new Option('--js').conflicts(['ts', 'jsx']);
       *
       * @param {(string | string[])} names
       * @return {Option}
       */
      conflicts(names) {
        this.conflictsWith = this.conflictsWith.concat(names);
        return this;
      }
      /**
       * Specify implied option values for when this option is set and the implied options are not.
       *
       * The custom processing (parseArg) is not called on the implied values.
       *
       * @example
       * program
       *   .addOption(new Option('--log', 'write logging information to file'))
       *   .addOption(new Option('--trace', 'log extra details').implies({ log: 'trace.txt' }));
       *
       * @param {object} impliedOptionValues
       * @return {Option}
       */
      implies(impliedOptionValues) {
        let newImplied = impliedOptionValues;
        if (typeof impliedOptionValues === "string") {
          newImplied = { [impliedOptionValues]: true };
        }
        this.implied = Object.assign(this.implied || {}, newImplied);
        return this;
      }
      /**
       * Set environment variable to check for option value.
       *
       * An environment variable is only used if when processed the current option value is
       * undefined, or the source of the current value is 'default' or 'config' or 'env'.
       *
       * @param {string} name
       * @return {Option}
       */
      env(name) {
        this.envVar = name;
        return this;
      }
      /**
       * Set the custom handler for processing CLI option arguments into option values.
       *
       * @param {Function} [fn]
       * @return {Option}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Whether the option is mandatory and must have a value after parsing.
       *
       * @param {boolean} [mandatory=true]
       * @return {Option}
       */
      makeOptionMandatory(mandatory = true) {
        this.mandatory = !!mandatory;
        return this;
      }
      /**
       * Hide option in help.
       *
       * @param {boolean} [hide=true]
       * @return {Option}
       */
      hideHelp(hide = true) {
        this.hidden = !!hide;
        return this;
      }
      /**
       * @package
       */
      _concatValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        return previous.concat(value);
      }
      /**
       * Only allow option value to be one of choices.
       *
       * @param {string[]} values
       * @return {Option}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._concatValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Return option name.
       *
       * @return {string}
       */
      name() {
        if (this.long) {
          return this.long.replace(/^--/, "");
        }
        return this.short.replace(/^-/, "");
      }
      /**
       * Return option name, in a camelcase format that can be used
       * as an object attribute key.
       *
       * @return {string}
       */
      attributeName() {
        if (this.negate) {
          return camelcase(this.name().replace(/^no-/, ""));
        }
        return camelcase(this.name());
      }
      /**
       * Check if `arg` matches the short or long flag.
       *
       * @param {string} arg
       * @return {boolean}
       * @package
       */
      is(arg) {
        return this.short === arg || this.long === arg;
      }
      /**
       * Return whether a boolean option.
       *
       * Options are one of boolean, negated, required argument, or optional argument.
       *
       * @return {boolean}
       * @package
       */
      isBoolean() {
        return !this.required && !this.optional && !this.negate;
      }
    };
    var DualOptions = class {
      /**
       * @param {Option[]} options
       */
      constructor(options) {
        this.positiveOptions = /* @__PURE__ */ new Map();
        this.negativeOptions = /* @__PURE__ */ new Map();
        this.dualOptions = /* @__PURE__ */ new Set();
        options.forEach((option) => {
          if (option.negate) {
            this.negativeOptions.set(option.attributeName(), option);
          } else {
            this.positiveOptions.set(option.attributeName(), option);
          }
        });
        this.negativeOptions.forEach((value, key) => {
          if (this.positiveOptions.has(key)) {
            this.dualOptions.add(key);
          }
        });
      }
      /**
       * Did the value come from the option, and not from possible matching dual option?
       *
       * @param {*} value
       * @param {Option} option
       * @returns {boolean}
       */
      valueFromOption(value, option) {
        const optionKey = option.attributeName();
        if (!this.dualOptions.has(optionKey)) return true;
        const preset = this.negativeOptions.get(optionKey).presetArg;
        const negativeValue = preset !== void 0 ? preset : false;
        return option.negate === (negativeValue === value);
      }
    };
    function camelcase(str) {
      return str.split("-").reduce((str2, word) => {
        return str2 + word[0].toUpperCase() + word.slice(1);
      });
    }
    function splitOptionFlags(flags) {
      let shortFlag;
      let longFlag;
      const shortFlagExp = /^-[^-]$/;
      const longFlagExp = /^--[^-]/;
      const flagParts = flags.split(/[ |,]+/).concat("guard");
      if (shortFlagExp.test(flagParts[0])) shortFlag = flagParts.shift();
      if (longFlagExp.test(flagParts[0])) longFlag = flagParts.shift();
      if (!shortFlag && shortFlagExp.test(flagParts[0]))
        shortFlag = flagParts.shift();
      if (!shortFlag && longFlagExp.test(flagParts[0])) {
        shortFlag = longFlag;
        longFlag = flagParts.shift();
      }
      if (flagParts[0].startsWith("-")) {
        const unsupportedFlag = flagParts[0];
        const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
        if (/^-[^-][^-]/.test(unsupportedFlag))
          throw new Error(
            `${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`
          );
        if (shortFlagExp.test(unsupportedFlag))
          throw new Error(`${baseError}
- too many short flags`);
        if (longFlagExp.test(unsupportedFlag))
          throw new Error(`${baseError}
- too many long flags`);
        throw new Error(`${baseError}
- unrecognised flag format`);
      }
      if (shortFlag === void 0 && longFlag === void 0)
        throw new Error(
          `option creation failed due to no flags found in '${flags}'.`
        );
      return { shortFlag, longFlag };
    }
    exports.Option = Option2;
    exports.DualOptions = DualOptions;
  }
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS({
  "node_modules/commander/lib/suggestSimilar.js"(exports) {
    var maxDistance = 3;
    function editDistance(a, b) {
      if (Math.abs(a.length - b.length) > maxDistance)
        return Math.max(a.length, b.length);
      const d = [];
      for (let i = 0; i <= a.length; i++) {
        d[i] = [i];
      }
      for (let j = 0; j <= b.length; j++) {
        d[0][j] = j;
      }
      for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
          let cost = 1;
          if (a[i - 1] === b[j - 1]) {
            cost = 0;
          } else {
            cost = 1;
          }
          d[i][j] = Math.min(
            d[i - 1][j] + 1,
            // deletion
            d[i][j - 1] + 1,
            // insertion
            d[i - 1][j - 1] + cost
            // substitution
          );
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
            d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
          }
        }
      }
      return d[a.length][b.length];
    }
    function suggestSimilar(word, candidates) {
      if (!candidates || candidates.length === 0) return "";
      candidates = Array.from(new Set(candidates));
      const searchingOptions = word.startsWith("--");
      if (searchingOptions) {
        word = word.slice(2);
        candidates = candidates.map((candidate) => candidate.slice(2));
      }
      let similar = [];
      let bestDistance = maxDistance;
      const minSimilarity = 0.4;
      candidates.forEach((candidate) => {
        if (candidate.length <= 1) return;
        const distance = editDistance(word, candidate);
        const length = Math.max(word.length, candidate.length);
        const similarity = (length - distance) / length;
        if (similarity > minSimilarity) {
          if (distance < bestDistance) {
            bestDistance = distance;
            similar = [candidate];
          } else if (distance === bestDistance) {
            similar.push(candidate);
          }
        }
      });
      similar.sort((a, b) => a.localeCompare(b));
      if (searchingOptions) {
        similar = similar.map((candidate) => `--${candidate}`);
      }
      if (similar.length > 1) {
        return `
(Did you mean one of ${similar.join(", ")}?)`;
      }
      if (similar.length === 1) {
        return `
(Did you mean ${similar[0]}?)`;
      }
      return "";
    }
    exports.suggestSimilar = suggestSimilar;
  }
});

// node_modules/commander/lib/command.js
var require_command = __commonJS({
  "node_modules/commander/lib/command.js"(exports) {
    var EventEmitter = __require("node:events").EventEmitter;
    var childProcess = __require("node:child_process");
    var path = __require("node:path");
    var fs = __require("node:fs");
    var process2 = __require("node:process");
    var { Argument: Argument2, humanReadableArgName } = require_argument();
    var { CommanderError: CommanderError2 } = require_error();
    var { Help: Help2, stripColor } = require_help();
    var { Option: Option2, DualOptions } = require_option();
    var { suggestSimilar } = require_suggestSimilar();
    var Command2 = class _Command extends EventEmitter {
      /**
       * Initialize a new `Command`.
       *
       * @param {string} [name]
       */
      constructor(name) {
        super();
        this.commands = [];
        this.options = [];
        this.parent = null;
        this._allowUnknownOption = false;
        this._allowExcessArguments = false;
        this.registeredArguments = [];
        this._args = this.registeredArguments;
        this.args = [];
        this.rawArgs = [];
        this.processedArgs = [];
        this._scriptPath = null;
        this._name = name || "";
        this._optionValues = {};
        this._optionValueSources = {};
        this._storeOptionsAsProperties = false;
        this._actionHandler = null;
        this._executableHandler = false;
        this._executableFile = null;
        this._executableDir = null;
        this._defaultCommandName = null;
        this._exitCallback = null;
        this._aliases = [];
        this._combineFlagAndOptionalValue = true;
        this._description = "";
        this._summary = "";
        this._argsDescription = void 0;
        this._enablePositionalOptions = false;
        this._passThroughOptions = false;
        this._lifeCycleHooks = {};
        this._showHelpAfterError = false;
        this._showSuggestionAfterError = true;
        this._savedState = null;
        this._outputConfiguration = {
          writeOut: (str) => process2.stdout.write(str),
          writeErr: (str) => process2.stderr.write(str),
          outputError: (str, write) => write(str),
          getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : void 0,
          getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : void 0,
          getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
          getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
          stripColor: (str) => stripColor(str)
        };
        this._hidden = false;
        this._helpOption = void 0;
        this._addImplicitHelpCommand = void 0;
        this._helpCommand = void 0;
        this._helpConfiguration = {};
      }
      /**
       * Copy settings that are useful to have in common across root command and subcommands.
       *
       * (Used internally when adding a command using `.command()` so subcommands inherit parent settings.)
       *
       * @param {Command} sourceCommand
       * @return {Command} `this` command for chaining
       */
      copyInheritedSettings(sourceCommand) {
        this._outputConfiguration = sourceCommand._outputConfiguration;
        this._helpOption = sourceCommand._helpOption;
        this._helpCommand = sourceCommand._helpCommand;
        this._helpConfiguration = sourceCommand._helpConfiguration;
        this._exitCallback = sourceCommand._exitCallback;
        this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
        this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
        this._allowExcessArguments = sourceCommand._allowExcessArguments;
        this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
        this._showHelpAfterError = sourceCommand._showHelpAfterError;
        this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
        return this;
      }
      /**
       * @returns {Command[]}
       * @private
       */
      _getCommandAndAncestors() {
        const result = [];
        for (let command = this; command; command = command.parent) {
          result.push(command);
        }
        return result;
      }
      /**
       * Define a command.
       *
       * There are two styles of command: pay attention to where to put the description.
       *
       * @example
       * // Command implemented using action handler (description is supplied separately to `.command`)
       * program
       *   .command('clone <source> [destination]')
       *   .description('clone a repository into a newly created directory')
       *   .action((source, destination) => {
       *     console.log('clone command called');
       *   });
       *
       * // Command implemented using separate executable file (description is second parameter to `.command`)
       * program
       *   .command('start <service>', 'start named service')
       *   .command('stop [service]', 'stop named service, or all if no name supplied');
       *
       * @param {string} nameAndArgs - command name and arguments, args are `<required>` or `[optional]` and last may also be `variadic...`
       * @param {(object | string)} [actionOptsOrExecDesc] - configuration options (for action), or description (for executable)
       * @param {object} [execOpts] - configuration options (for executable)
       * @return {Command} returns new command for action handler, or `this` for executable command
       */
      command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
        let desc = actionOptsOrExecDesc;
        let opts = execOpts;
        if (typeof desc === "object" && desc !== null) {
          opts = desc;
          desc = null;
        }
        opts = opts || {};
        const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
        const cmd = this.createCommand(name);
        if (desc) {
          cmd.description(desc);
          cmd._executableHandler = true;
        }
        if (opts.isDefault) this._defaultCommandName = cmd._name;
        cmd._hidden = !!(opts.noHelp || opts.hidden);
        cmd._executableFile = opts.executableFile || null;
        if (args) cmd.arguments(args);
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd.copyInheritedSettings(this);
        if (desc) return this;
        return cmd;
      }
      /**
       * Factory routine to create a new unattached command.
       *
       * See .command() for creating an attached subcommand, which uses this routine to
       * create the command. You can override createCommand to customise subcommands.
       *
       * @param {string} [name]
       * @return {Command} new command
       */
      createCommand(name) {
        return new _Command(name);
      }
      /**
       * You can customise the help with a subclass of Help by overriding createHelp,
       * or by overriding Help properties using configureHelp().
       *
       * @return {Help}
       */
      createHelp() {
        return Object.assign(new Help2(), this.configureHelp());
      }
      /**
       * You can customise the help by overriding Help properties using configureHelp(),
       * or with a subclass of Help by overriding createHelp().
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureHelp(configuration) {
        if (configuration === void 0) return this._helpConfiguration;
        this._helpConfiguration = configuration;
        return this;
      }
      /**
       * The default output goes to stdout and stderr. You can customise this for special
       * applications. You can also customise the display of errors by overriding outputError.
       *
       * The configuration properties are all functions:
       *
       *     // change how output being written, defaults to stdout and stderr
       *     writeOut(str)
       *     writeErr(str)
       *     // change how output being written for errors, defaults to writeErr
       *     outputError(str, write) // used for displaying errors and not used for displaying help
       *     // specify width for wrapping help
       *     getOutHelpWidth()
       *     getErrHelpWidth()
       *     // color support, currently only used with Help
       *     getOutHasColors()
       *     getErrHasColors()
       *     stripColor() // used to remove ANSI escape codes if output does not have colors
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureOutput(configuration) {
        if (configuration === void 0) return this._outputConfiguration;
        Object.assign(this._outputConfiguration, configuration);
        return this;
      }
      /**
       * Display the help or a custom message after an error occurs.
       *
       * @param {(boolean|string)} [displayHelp]
       * @return {Command} `this` command for chaining
       */
      showHelpAfterError(displayHelp = true) {
        if (typeof displayHelp !== "string") displayHelp = !!displayHelp;
        this._showHelpAfterError = displayHelp;
        return this;
      }
      /**
       * Display suggestion of similar commands for unknown commands, or options for unknown options.
       *
       * @param {boolean} [displaySuggestion]
       * @return {Command} `this` command for chaining
       */
      showSuggestionAfterError(displaySuggestion = true) {
        this._showSuggestionAfterError = !!displaySuggestion;
        return this;
      }
      /**
       * Add a prepared subcommand.
       *
       * See .command() for creating an attached subcommand which inherits settings from its parent.
       *
       * @param {Command} cmd - new subcommand
       * @param {object} [opts] - configuration options
       * @return {Command} `this` command for chaining
       */
      addCommand(cmd, opts) {
        if (!cmd._name) {
          throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
        }
        opts = opts || {};
        if (opts.isDefault) this._defaultCommandName = cmd._name;
        if (opts.noHelp || opts.hidden) cmd._hidden = true;
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd._checkForBrokenPassThrough();
        return this;
      }
      /**
       * Factory routine to create a new unattached argument.
       *
       * See .argument() for creating an attached argument, which uses this routine to
       * create the argument. You can override createArgument to return a custom argument.
       *
       * @param {string} name
       * @param {string} [description]
       * @return {Argument} new argument
       */
      createArgument(name, description) {
        return new Argument2(name, description);
      }
      /**
       * Define argument syntax for command.
       *
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @example
       * program.argument('<input-file>');
       * program.argument('[output-file]');
       *
       * @param {string} name
       * @param {string} [description]
       * @param {(Function|*)} [fn] - custom argument processing function
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      argument(name, description, fn, defaultValue) {
        const argument = this.createArgument(name, description);
        if (typeof fn === "function") {
          argument.default(defaultValue).argParser(fn);
        } else {
          argument.default(fn);
        }
        this.addArgument(argument);
        return this;
      }
      /**
       * Define argument syntax for command, adding multiple at once (without descriptions).
       *
       * See also .argument().
       *
       * @example
       * program.arguments('<cmd> [env]');
       *
       * @param {string} names
       * @return {Command} `this` command for chaining
       */
      arguments(names) {
        names.trim().split(/ +/).forEach((detail) => {
          this.argument(detail);
        });
        return this;
      }
      /**
       * Define argument syntax for command, adding a prepared argument.
       *
       * @param {Argument} argument
       * @return {Command} `this` command for chaining
       */
      addArgument(argument) {
        const previousArgument = this.registeredArguments.slice(-1)[0];
        if (previousArgument && previousArgument.variadic) {
          throw new Error(
            `only the last argument can be variadic '${previousArgument.name()}'`
          );
        }
        if (argument.required && argument.defaultValue !== void 0 && argument.parseArg === void 0) {
          throw new Error(
            `a default value for a required argument is never used: '${argument.name()}'`
          );
        }
        this.registeredArguments.push(argument);
        return this;
      }
      /**
       * Customise or override default help command. By default a help command is automatically added if your command has subcommands.
       *
       * @example
       *    program.helpCommand('help [cmd]');
       *    program.helpCommand('help [cmd]', 'show help');
       *    program.helpCommand(false); // suppress default help command
       *    program.helpCommand(true); // add help command even if no subcommands
       *
       * @param {string|boolean} enableOrNameAndArgs - enable with custom name and/or arguments, or boolean to override whether added
       * @param {string} [description] - custom description
       * @return {Command} `this` command for chaining
       */
      helpCommand(enableOrNameAndArgs, description) {
        if (typeof enableOrNameAndArgs === "boolean") {
          this._addImplicitHelpCommand = enableOrNameAndArgs;
          return this;
        }
        enableOrNameAndArgs = enableOrNameAndArgs ?? "help [command]";
        const [, helpName, helpArgs] = enableOrNameAndArgs.match(/([^ ]+) *(.*)/);
        const helpDescription = description ?? "display help for command";
        const helpCommand = this.createCommand(helpName);
        helpCommand.helpOption(false);
        if (helpArgs) helpCommand.arguments(helpArgs);
        if (helpDescription) helpCommand.description(helpDescription);
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        return this;
      }
      /**
       * Add prepared custom help command.
       *
       * @param {(Command|string|boolean)} helpCommand - custom help command, or deprecated enableOrNameAndArgs as for `.helpCommand()`
       * @param {string} [deprecatedDescription] - deprecated custom description used with custom name only
       * @return {Command} `this` command for chaining
       */
      addHelpCommand(helpCommand, deprecatedDescription) {
        if (typeof helpCommand !== "object") {
          this.helpCommand(helpCommand, deprecatedDescription);
          return this;
        }
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        return this;
      }
      /**
       * Lazy create help command.
       *
       * @return {(Command|null)}
       * @package
       */
      _getHelpCommand() {
        const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
        if (hasImplicitHelpCommand) {
          if (this._helpCommand === void 0) {
            this.helpCommand(void 0, void 0);
          }
          return this._helpCommand;
        }
        return null;
      }
      /**
       * Add hook for life cycle event.
       *
       * @param {string} event
       * @param {Function} listener
       * @return {Command} `this` command for chaining
       */
      hook(event, listener) {
        const allowedValues = ["preSubcommand", "preAction", "postAction"];
        if (!allowedValues.includes(event)) {
          throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        if (this._lifeCycleHooks[event]) {
          this._lifeCycleHooks[event].push(listener);
        } else {
          this._lifeCycleHooks[event] = [listener];
        }
        return this;
      }
      /**
       * Register callback to use as replacement for calling process.exit.
       *
       * @param {Function} [fn] optional callback which will be passed a CommanderError, defaults to throwing
       * @return {Command} `this` command for chaining
       */
      exitOverride(fn) {
        if (fn) {
          this._exitCallback = fn;
        } else {
          this._exitCallback = (err) => {
            if (err.code !== "commander.executeSubCommandAsync") {
              throw err;
            } else {
            }
          };
        }
        return this;
      }
      /**
       * Call process.exit, and _exitCallback if defined.
       *
       * @param {number} exitCode exit code for using with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       * @return never
       * @private
       */
      _exit(exitCode, code, message) {
        if (this._exitCallback) {
          this._exitCallback(new CommanderError2(exitCode, code, message));
        }
        process2.exit(exitCode);
      }
      /**
       * Register callback `fn` for the command.
       *
       * @example
       * program
       *   .command('serve')
       *   .description('start service')
       *   .action(function() {
       *      // do work here
       *   });
       *
       * @param {Function} fn
       * @return {Command} `this` command for chaining
       */
      action(fn) {
        const listener = (args) => {
          const expectedArgsCount = this.registeredArguments.length;
          const actionArgs = args.slice(0, expectedArgsCount);
          if (this._storeOptionsAsProperties) {
            actionArgs[expectedArgsCount] = this;
          } else {
            actionArgs[expectedArgsCount] = this.opts();
          }
          actionArgs.push(this);
          return fn.apply(this, actionArgs);
        };
        this._actionHandler = listener;
        return this;
      }
      /**
       * Factory routine to create a new unattached option.
       *
       * See .option() for creating an attached option, which uses this routine to
       * create the option. You can override createOption to return a custom option.
       *
       * @param {string} flags
       * @param {string} [description]
       * @return {Option} new option
       */
      createOption(flags, description) {
        return new Option2(flags, description);
      }
      /**
       * Wrap parseArgs to catch 'commander.invalidArgument'.
       *
       * @param {(Option | Argument)} target
       * @param {string} value
       * @param {*} previous
       * @param {string} invalidArgumentMessage
       * @private
       */
      _callParseArg(target, value, previous, invalidArgumentMessage) {
        try {
          return target.parseArg(value, previous);
        } catch (err) {
          if (err.code === "commander.invalidArgument") {
            const message = `${invalidArgumentMessage} ${err.message}`;
            this.error(message, { exitCode: err.exitCode, code: err.code });
          }
          throw err;
        }
      }
      /**
       * Check for option flag conflicts.
       * Register option if no conflicts found, or throw on conflict.
       *
       * @param {Option} option
       * @private
       */
      _registerOption(option) {
        const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
        if (matchingOption) {
          const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
          throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
        }
        this.options.push(option);
      }
      /**
       * Check for command name and alias conflicts with existing commands.
       * Register command if no conflicts found, or throw on conflict.
       *
       * @param {Command} command
       * @private
       */
      _registerCommand(command) {
        const knownBy = (cmd) => {
          return [cmd.name()].concat(cmd.aliases());
        };
        const alreadyUsed = knownBy(command).find(
          (name) => this._findCommand(name)
        );
        if (alreadyUsed) {
          const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
          const newCmd = knownBy(command).join("|");
          throw new Error(
            `cannot add command '${newCmd}' as already have command '${existingCmd}'`
          );
        }
        this.commands.push(command);
      }
      /**
       * Add an option.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addOption(option) {
        this._registerOption(option);
        const oname = option.name();
        const name = option.attributeName();
        if (option.negate) {
          const positiveLongFlag = option.long.replace(/^--no-/, "--");
          if (!this._findOption(positiveLongFlag)) {
            this.setOptionValueWithSource(
              name,
              option.defaultValue === void 0 ? true : option.defaultValue,
              "default"
            );
          }
        } else if (option.defaultValue !== void 0) {
          this.setOptionValueWithSource(name, option.defaultValue, "default");
        }
        const handleOptionValue = (val, invalidValueMessage, valueSource) => {
          if (val == null && option.presetArg !== void 0) {
            val = option.presetArg;
          }
          const oldValue = this.getOptionValue(name);
          if (val !== null && option.parseArg) {
            val = this._callParseArg(option, val, oldValue, invalidValueMessage);
          } else if (val !== null && option.variadic) {
            val = option._concatValue(val, oldValue);
          }
          if (val == null) {
            if (option.negate) {
              val = false;
            } else if (option.isBoolean() || option.optional) {
              val = true;
            } else {
              val = "";
            }
          }
          this.setOptionValueWithSource(name, val, valueSource);
        };
        this.on("option:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "cli");
        });
        if (option.envVar) {
          this.on("optionEnv:" + oname, (val) => {
            const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
            handleOptionValue(val, invalidValueMessage, "env");
          });
        }
        return this;
      }
      /**
       * Internal implementation shared by .option() and .requiredOption()
       *
       * @return {Command} `this` command for chaining
       * @private
       */
      _optionEx(config, flags, description, fn, defaultValue) {
        if (typeof flags === "object" && flags instanceof Option2) {
          throw new Error(
            "To add an Option object use addOption() instead of option() or requiredOption()"
          );
        }
        const option = this.createOption(flags, description);
        option.makeOptionMandatory(!!config.mandatory);
        if (typeof fn === "function") {
          option.default(defaultValue).argParser(fn);
        } else if (fn instanceof RegExp) {
          const regex = fn;
          fn = (val, def) => {
            const m = regex.exec(val);
            return m ? m[0] : def;
          };
          option.default(defaultValue).argParser(fn);
        } else {
          option.default(fn);
        }
        return this.addOption(option);
      }
      /**
       * Define option with `flags`, `description`, and optional argument parsing function or `defaultValue` or both.
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space. A required
       * option-argument is indicated by `<>` and an optional option-argument by `[]`.
       *
       * See the README for more details, and see also addOption() and requiredOption().
       *
       * @example
       * program
       *     .option('-p, --pepper', 'add pepper')
       *     .option('--pt, --pizza-type <TYPE>', 'type of pizza') // required option-argument
       *     .option('-c, --cheese [CHEESE]', 'add extra cheese', 'mozzarella') // optional option-argument with default
       *     .option('-t, --tip <VALUE>', 'add tip to purchase cost', parseFloat) // custom parse function
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      option(flags, description, parseArg, defaultValue) {
        return this._optionEx({}, flags, description, parseArg, defaultValue);
      }
      /**
       * Add a required option which must have a value after parsing. This usually means
       * the option must be specified on the command line. (Otherwise the same as .option().)
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space.
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      requiredOption(flags, description, parseArg, defaultValue) {
        return this._optionEx(
          { mandatory: true },
          flags,
          description,
          parseArg,
          defaultValue
        );
      }
      /**
       * Alter parsing of short flags with optional values.
       *
       * @example
       * // for `.option('-f,--flag [value]'):
       * program.combineFlagAndOptionalValue(true);  // `-f80` is treated like `--flag=80`, this is the default behaviour
       * program.combineFlagAndOptionalValue(false) // `-fb` is treated like `-f -b`
       *
       * @param {boolean} [combine] - if `true` or omitted, an optional value can be specified directly after the flag.
       * @return {Command} `this` command for chaining
       */
      combineFlagAndOptionalValue(combine = true) {
        this._combineFlagAndOptionalValue = !!combine;
        return this;
      }
      /**
       * Allow unknown options on the command line.
       *
       * @param {boolean} [allowUnknown] - if `true` or omitted, no error will be thrown for unknown options.
       * @return {Command} `this` command for chaining
       */
      allowUnknownOption(allowUnknown = true) {
        this._allowUnknownOption = !!allowUnknown;
        return this;
      }
      /**
       * Allow excess command-arguments on the command line. Pass false to make excess arguments an error.
       *
       * @param {boolean} [allowExcess] - if `true` or omitted, no error will be thrown for excess arguments.
       * @return {Command} `this` command for chaining
       */
      allowExcessArguments(allowExcess = true) {
        this._allowExcessArguments = !!allowExcess;
        return this;
      }
      /**
       * Enable positional options. Positional means global options are specified before subcommands which lets
       * subcommands reuse the same option names, and also enables subcommands to turn on passThroughOptions.
       * The default behaviour is non-positional and global options may appear anywhere on the command line.
       *
       * @param {boolean} [positional]
       * @return {Command} `this` command for chaining
       */
      enablePositionalOptions(positional = true) {
        this._enablePositionalOptions = !!positional;
        return this;
      }
      /**
       * Pass through options that come after command-arguments rather than treat them as command-options,
       * so actual command-options come before command-arguments. Turning this on for a subcommand requires
       * positional options to have been enabled on the program (parent commands).
       * The default behaviour is non-positional and options may appear before or after command-arguments.
       *
       * @param {boolean} [passThrough] for unknown options.
       * @return {Command} `this` command for chaining
       */
      passThroughOptions(passThrough = true) {
        this._passThroughOptions = !!passThrough;
        this._checkForBrokenPassThrough();
        return this;
      }
      /**
       * @private
       */
      _checkForBrokenPassThrough() {
        if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
          throw new Error(
            `passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`
          );
        }
      }
      /**
       * Whether to store option values as properties on command object,
       * or store separately (specify false). In both cases the option values can be accessed using .opts().
       *
       * @param {boolean} [storeAsProperties=true]
       * @return {Command} `this` command for chaining
       */
      storeOptionsAsProperties(storeAsProperties = true) {
        if (this.options.length) {
          throw new Error("call .storeOptionsAsProperties() before adding options");
        }
        if (Object.keys(this._optionValues).length) {
          throw new Error(
            "call .storeOptionsAsProperties() before setting option values"
          );
        }
        this._storeOptionsAsProperties = !!storeAsProperties;
        return this;
      }
      /**
       * Retrieve option value.
       *
       * @param {string} key
       * @return {object} value
       */
      getOptionValue(key) {
        if (this._storeOptionsAsProperties) {
          return this[key];
        }
        return this._optionValues[key];
      }
      /**
       * Store option value.
       *
       * @param {string} key
       * @param {object} value
       * @return {Command} `this` command for chaining
       */
      setOptionValue(key, value) {
        return this.setOptionValueWithSource(key, value, void 0);
      }
      /**
       * Store option value and where the value came from.
       *
       * @param {string} key
       * @param {object} value
       * @param {string} source - expected values are default/config/env/cli/implied
       * @return {Command} `this` command for chaining
       */
      setOptionValueWithSource(key, value, source) {
        if (this._storeOptionsAsProperties) {
          this[key] = value;
        } else {
          this._optionValues[key] = value;
        }
        this._optionValueSources[key] = source;
        return this;
      }
      /**
       * Get source of option value.
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSource(key) {
        return this._optionValueSources[key];
      }
      /**
       * Get source of option value. See also .optsWithGlobals().
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSourceWithGlobals(key) {
        let source;
        this._getCommandAndAncestors().forEach((cmd) => {
          if (cmd.getOptionValueSource(key) !== void 0) {
            source = cmd.getOptionValueSource(key);
          }
        });
        return source;
      }
      /**
       * Get user arguments from implied or explicit arguments.
       * Side-effects: set _scriptPath if args included script. Used for default program name, and subcommand searches.
       *
       * @private
       */
      _prepareUserArgs(argv, parseOptions) {
        if (argv !== void 0 && !Array.isArray(argv)) {
          throw new Error("first parameter to parse must be array or undefined");
        }
        parseOptions = parseOptions || {};
        if (argv === void 0 && parseOptions.from === void 0) {
          if (process2.versions?.electron) {
            parseOptions.from = "electron";
          }
          const execArgv = process2.execArgv ?? [];
          if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
            parseOptions.from = "eval";
          }
        }
        if (argv === void 0) {
          argv = process2.argv;
        }
        this.rawArgs = argv.slice();
        let userArgs;
        switch (parseOptions.from) {
          case void 0:
          case "node":
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
            break;
          case "electron":
            if (process2.defaultApp) {
              this._scriptPath = argv[1];
              userArgs = argv.slice(2);
            } else {
              userArgs = argv.slice(1);
            }
            break;
          case "user":
            userArgs = argv.slice(0);
            break;
          case "eval":
            userArgs = argv.slice(1);
            break;
          default:
            throw new Error(
              `unexpected parse option { from: '${parseOptions.from}' }`
            );
        }
        if (!this._name && this._scriptPath)
          this.nameFromFilename(this._scriptPath);
        this._name = this._name || "program";
        return userArgs;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Use parseAsync instead of parse if any of your action handlers are async.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * program.parse(); // parse process.argv and auto-detect electron and special node flags
       * program.parse(process.argv); // assume argv[0] is app and argv[1] is script
       * program.parse(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv] - optional, defaults to process.argv
       * @param {object} [parseOptions] - optionally specify style of options with from: node/user/electron
       * @param {string} [parseOptions.from] - where the args are from: 'node', 'user', 'electron'
       * @return {Command} `this` command for chaining
       */
      parse(argv, parseOptions) {
        this._prepareForParse();
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        this._parseCommand([], userArgs);
        return this;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * await program.parseAsync(); // parse process.argv and auto-detect electron and special node flags
       * await program.parseAsync(process.argv); // assume argv[0] is app and argv[1] is script
       * await program.parseAsync(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv]
       * @param {object} [parseOptions]
       * @param {string} parseOptions.from - where the args are from: 'node', 'user', 'electron'
       * @return {Promise}
       */
      async parseAsync(argv, parseOptions) {
        this._prepareForParse();
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        await this._parseCommand([], userArgs);
        return this;
      }
      _prepareForParse() {
        if (this._savedState === null) {
          this.saveStateBeforeParse();
        } else {
          this.restoreStateBeforeParse();
        }
      }
      /**
       * Called the first time parse is called to save state and allow a restore before subsequent calls to parse.
       * Not usually called directly, but available for subclasses to save their custom state.
       *
       * This is called in a lazy way. Only commands used in parsing chain will have state saved.
       */
      saveStateBeforeParse() {
        this._savedState = {
          // name is stable if supplied by author, but may be unspecified for root command and deduced during parsing
          _name: this._name,
          // option values before parse have default values (including false for negated options)
          // shallow clones
          _optionValues: { ...this._optionValues },
          _optionValueSources: { ...this._optionValueSources }
        };
      }
      /**
       * Restore state before parse for calls after the first.
       * Not usually called directly, but available for subclasses to save their custom state.
       *
       * This is called in a lazy way. Only commands used in parsing chain will have state restored.
       */
      restoreStateBeforeParse() {
        if (this._storeOptionsAsProperties)
          throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
        this._name = this._savedState._name;
        this._scriptPath = null;
        this.rawArgs = [];
        this._optionValues = { ...this._savedState._optionValues };
        this._optionValueSources = { ...this._savedState._optionValueSources };
        this.args = [];
        this.processedArgs = [];
      }
      /**
       * Throw if expected executable is missing. Add lots of help for author.
       *
       * @param {string} executableFile
       * @param {string} executableDir
       * @param {string} subcommandName
       */
      _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
        if (fs.existsSync(executableFile)) return;
        const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
        const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
        throw new Error(executableMissing);
      }
      /**
       * Execute a sub-command executable.
       *
       * @private
       */
      _executeSubCommand(subcommand, args) {
        args = args.slice();
        let launchWithNode = false;
        const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
        function findFile(baseDir, baseName) {
          const localBin = path.resolve(baseDir, baseName);
          if (fs.existsSync(localBin)) return localBin;
          if (sourceExt.includes(path.extname(baseName))) return void 0;
          const foundExt = sourceExt.find(
            (ext) => fs.existsSync(`${localBin}${ext}`)
          );
          if (foundExt) return `${localBin}${foundExt}`;
          return void 0;
        }
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
        let executableDir = this._executableDir || "";
        if (this._scriptPath) {
          let resolvedScriptPath;
          try {
            resolvedScriptPath = fs.realpathSync(this._scriptPath);
          } catch {
            resolvedScriptPath = this._scriptPath;
          }
          executableDir = path.resolve(
            path.dirname(resolvedScriptPath),
            executableDir
          );
        }
        if (executableDir) {
          let localFile = findFile(executableDir, executableFile);
          if (!localFile && !subcommand._executableFile && this._scriptPath) {
            const legacyName = path.basename(
              this._scriptPath,
              path.extname(this._scriptPath)
            );
            if (legacyName !== this._name) {
              localFile = findFile(
                executableDir,
                `${legacyName}-${subcommand._name}`
              );
            }
          }
          executableFile = localFile || executableFile;
        }
        launchWithNode = sourceExt.includes(path.extname(executableFile));
        let proc;
        if (process2.platform !== "win32") {
          if (launchWithNode) {
            args.unshift(executableFile);
            args = incrementNodeInspectorPort(process2.execArgv).concat(args);
            proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
          } else {
            proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
          }
        } else {
          this._checkForMissingExecutable(
            executableFile,
            executableDir,
            subcommand._name
          );
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
        }
        if (!proc.killed) {
          const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
          signals.forEach((signal) => {
            process2.on(signal, () => {
              if (proc.killed === false && proc.exitCode === null) {
                proc.kill(signal);
              }
            });
          });
        }
        const exitCallback = this._exitCallback;
        proc.on("close", (code) => {
          code = code ?? 1;
          if (!exitCallback) {
            process2.exit(code);
          } else {
            exitCallback(
              new CommanderError2(
                code,
                "commander.executeSubCommandAsync",
                "(close)"
              )
            );
          }
        });
        proc.on("error", (err) => {
          if (err.code === "ENOENT") {
            this._checkForMissingExecutable(
              executableFile,
              executableDir,
              subcommand._name
            );
          } else if (err.code === "EACCES") {
            throw new Error(`'${executableFile}' not executable`);
          }
          if (!exitCallback) {
            process2.exit(1);
          } else {
            const wrappedError = new CommanderError2(
              1,
              "commander.executeSubCommandAsync",
              "(error)"
            );
            wrappedError.nestedError = err;
            exitCallback(wrappedError);
          }
        });
        this.runningCommand = proc;
      }
      /**
       * @private
       */
      _dispatchSubcommand(commandName, operands, unknown) {
        const subCommand = this._findCommand(commandName);
        if (!subCommand) this.help({ error: true });
        subCommand._prepareForParse();
        let promiseChain;
        promiseChain = this._chainOrCallSubCommandHook(
          promiseChain,
          subCommand,
          "preSubcommand"
        );
        promiseChain = this._chainOrCall(promiseChain, () => {
          if (subCommand._executableHandler) {
            this._executeSubCommand(subCommand, operands.concat(unknown));
          } else {
            return subCommand._parseCommand(operands, unknown);
          }
        });
        return promiseChain;
      }
      /**
       * Invoke help directly if possible, or dispatch if necessary.
       * e.g. help foo
       *
       * @private
       */
      _dispatchHelpCommand(subcommandName) {
        if (!subcommandName) {
          this.help();
        }
        const subCommand = this._findCommand(subcommandName);
        if (subCommand && !subCommand._executableHandler) {
          subCommand.help();
        }
        return this._dispatchSubcommand(
          subcommandName,
          [],
          [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]
        );
      }
      /**
       * Check this.args against expected this.registeredArguments.
       *
       * @private
       */
      _checkNumberOfArguments() {
        this.registeredArguments.forEach((arg, i) => {
          if (arg.required && this.args[i] == null) {
            this.missingArgument(arg.name());
          }
        });
        if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
          return;
        }
        if (this.args.length > this.registeredArguments.length) {
          this._excessArguments(this.args);
        }
      }
      /**
       * Process this.args using this.registeredArguments and save as this.processedArgs!
       *
       * @private
       */
      _processArguments() {
        const myParseArg = (argument, value, previous) => {
          let parsedValue = value;
          if (value !== null && argument.parseArg) {
            const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
            parsedValue = this._callParseArg(
              argument,
              value,
              previous,
              invalidValueMessage
            );
          }
          return parsedValue;
        };
        this._checkNumberOfArguments();
        const processedArgs = [];
        this.registeredArguments.forEach((declaredArg, index) => {
          let value = declaredArg.defaultValue;
          if (declaredArg.variadic) {
            if (index < this.args.length) {
              value = this.args.slice(index);
              if (declaredArg.parseArg) {
                value = value.reduce((processed, v) => {
                  return myParseArg(declaredArg, v, processed);
                }, declaredArg.defaultValue);
              }
            } else if (value === void 0) {
              value = [];
            }
          } else if (index < this.args.length) {
            value = this.args[index];
            if (declaredArg.parseArg) {
              value = myParseArg(declaredArg, value, declaredArg.defaultValue);
            }
          }
          processedArgs[index] = value;
        });
        this.processedArgs = processedArgs;
      }
      /**
       * Once we have a promise we chain, but call synchronously until then.
       *
       * @param {(Promise|undefined)} promise
       * @param {Function} fn
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCall(promise, fn) {
        if (promise && promise.then && typeof promise.then === "function") {
          return promise.then(() => fn());
        }
        return fn();
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallHooks(promise, event) {
        let result = promise;
        const hooks = [];
        this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== void 0).forEach((hookedCommand) => {
          hookedCommand._lifeCycleHooks[event].forEach((callback) => {
            hooks.push({ hookedCommand, callback });
          });
        });
        if (event === "postAction") {
          hooks.reverse();
        }
        hooks.forEach((hookDetail) => {
          result = this._chainOrCall(result, () => {
            return hookDetail.callback(hookDetail.hookedCommand, this);
          });
        });
        return result;
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {Command} subCommand
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallSubCommandHook(promise, subCommand, event) {
        let result = promise;
        if (this._lifeCycleHooks[event] !== void 0) {
          this._lifeCycleHooks[event].forEach((hook) => {
            result = this._chainOrCall(result, () => {
              return hook(this, subCommand);
            });
          });
        }
        return result;
      }
      /**
       * Process arguments in context of this command.
       * Returns action result, in case it is a promise.
       *
       * @private
       */
      _parseCommand(operands, unknown) {
        const parsed = this.parseOptions(unknown);
        this._parseOptionsEnv();
        this._parseOptionsImplied();
        operands = operands.concat(parsed.operands);
        unknown = parsed.unknown;
        this.args = operands.concat(unknown);
        if (operands && this._findCommand(operands[0])) {
          return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
        }
        if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
          return this._dispatchHelpCommand(operands[1]);
        }
        if (this._defaultCommandName) {
          this._outputHelpIfRequested(unknown);
          return this._dispatchSubcommand(
            this._defaultCommandName,
            operands,
            unknown
          );
        }
        if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
          this.help({ error: true });
        }
        this._outputHelpIfRequested(parsed.unknown);
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        const checkForUnknownOptions = () => {
          if (parsed.unknown.length > 0) {
            this.unknownOption(parsed.unknown[0]);
          }
        };
        const commandEvent = `command:${this.name()}`;
        if (this._actionHandler) {
          checkForUnknownOptions();
          this._processArguments();
          let promiseChain;
          promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
          promiseChain = this._chainOrCall(
            promiseChain,
            () => this._actionHandler(this.processedArgs)
          );
          if (this.parent) {
            promiseChain = this._chainOrCall(promiseChain, () => {
              this.parent.emit(commandEvent, operands, unknown);
            });
          }
          promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
          return promiseChain;
        }
        if (this.parent && this.parent.listenerCount(commandEvent)) {
          checkForUnknownOptions();
          this._processArguments();
          this.parent.emit(commandEvent, operands, unknown);
        } else if (operands.length) {
          if (this._findCommand("*")) {
            return this._dispatchSubcommand("*", operands, unknown);
          }
          if (this.listenerCount("command:*")) {
            this.emit("command:*", operands, unknown);
          } else if (this.commands.length) {
            this.unknownCommand();
          } else {
            checkForUnknownOptions();
            this._processArguments();
          }
        } else if (this.commands.length) {
          checkForUnknownOptions();
          this.help({ error: true });
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      }
      /**
       * Find matching command.
       *
       * @private
       * @return {Command | undefined}
       */
      _findCommand(name) {
        if (!name) return void 0;
        return this.commands.find(
          (cmd) => cmd._name === name || cmd._aliases.includes(name)
        );
      }
      /**
       * Return an option matching `arg` if any.
       *
       * @param {string} arg
       * @return {Option}
       * @package
       */
      _findOption(arg) {
        return this.options.find((option) => option.is(arg));
      }
      /**
       * Display an error message if a mandatory option does not have a value.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForMissingMandatoryOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd.options.forEach((anOption) => {
            if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === void 0) {
              cmd.missingMandatoryOptionValue(anOption);
            }
          });
        });
      }
      /**
       * Display an error message if conflicting options are used together in this.
       *
       * @private
       */
      _checkForConflictingLocalOptions() {
        const definedNonDefaultOptions = this.options.filter((option) => {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === void 0) {
            return false;
          }
          return this.getOptionValueSource(optionKey) !== "default";
        });
        const optionsWithConflicting = definedNonDefaultOptions.filter(
          (option) => option.conflictsWith.length > 0
        );
        optionsWithConflicting.forEach((option) => {
          const conflictingAndDefined = definedNonDefaultOptions.find(
            (defined) => option.conflictsWith.includes(defined.attributeName())
          );
          if (conflictingAndDefined) {
            this._conflictingOption(option, conflictingAndDefined);
          }
        });
      }
      /**
       * Display an error message if conflicting options are used together.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForConflictingOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd._checkForConflictingLocalOptions();
        });
      }
      /**
       * Parse options from `argv` removing known options,
       * and return argv split into operands and unknown arguments.
       *
       * Side effects: modifies command by storing options. Does not reset state if called again.
       *
       * Examples:
       *
       *     argv => operands, unknown
       *     --known kkk op => [op], []
       *     op --known kkk => [op], []
       *     sub --unknown uuu op => [sub], [--unknown uuu op]
       *     sub -- --unknown uuu op => [sub --unknown uuu op], []
       *
       * @param {string[]} argv
       * @return {{operands: string[], unknown: string[]}}
       */
      parseOptions(argv) {
        const operands = [];
        const unknown = [];
        let dest = operands;
        const args = argv.slice();
        function maybeOption(arg) {
          return arg.length > 1 && arg[0] === "-";
        }
        let activeVariadicOption = null;
        while (args.length) {
          const arg = args.shift();
          if (arg === "--") {
            if (dest === unknown) dest.push(arg);
            dest.push(...args);
            break;
          }
          if (activeVariadicOption && !maybeOption(arg)) {
            this.emit(`option:${activeVariadicOption.name()}`, arg);
            continue;
          }
          activeVariadicOption = null;
          if (maybeOption(arg)) {
            const option = this._findOption(arg);
            if (option) {
              if (option.required) {
                const value = args.shift();
                if (value === void 0) this.optionMissingArgument(option);
                this.emit(`option:${option.name()}`, value);
              } else if (option.optional) {
                let value = null;
                if (args.length > 0 && !maybeOption(args[0])) {
                  value = args.shift();
                }
                this.emit(`option:${option.name()}`, value);
              } else {
                this.emit(`option:${option.name()}`);
              }
              activeVariadicOption = option.variadic ? option : null;
              continue;
            }
          }
          if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
            const option = this._findOption(`-${arg[1]}`);
            if (option) {
              if (option.required || option.optional && this._combineFlagAndOptionalValue) {
                this.emit(`option:${option.name()}`, arg.slice(2));
              } else {
                this.emit(`option:${option.name()}`);
                args.unshift(`-${arg.slice(2)}`);
              }
              continue;
            }
          }
          if (/^--[^=]+=/.test(arg)) {
            const index = arg.indexOf("=");
            const option = this._findOption(arg.slice(0, index));
            if (option && (option.required || option.optional)) {
              this.emit(`option:${option.name()}`, arg.slice(index + 1));
              continue;
            }
          }
          if (maybeOption(arg)) {
            dest = unknown;
          }
          if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
            if (this._findCommand(arg)) {
              operands.push(arg);
              if (args.length > 0) unknown.push(...args);
              break;
            } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
              operands.push(arg);
              if (args.length > 0) operands.push(...args);
              break;
            } else if (this._defaultCommandName) {
              unknown.push(arg);
              if (args.length > 0) unknown.push(...args);
              break;
            }
          }
          if (this._passThroughOptions) {
            dest.push(arg);
            if (args.length > 0) dest.push(...args);
            break;
          }
          dest.push(arg);
        }
        return { operands, unknown };
      }
      /**
       * Return an object containing local option values as key-value pairs.
       *
       * @return {object}
       */
      opts() {
        if (this._storeOptionsAsProperties) {
          const result = {};
          const len = this.options.length;
          for (let i = 0; i < len; i++) {
            const key = this.options[i].attributeName();
            result[key] = key === this._versionOptionName ? this._version : this[key];
          }
          return result;
        }
        return this._optionValues;
      }
      /**
       * Return an object containing merged local and global option values as key-value pairs.
       *
       * @return {object}
       */
      optsWithGlobals() {
        return this._getCommandAndAncestors().reduce(
          (combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
          {}
        );
      }
      /**
       * Display error message and exit (or call exitOverride).
       *
       * @param {string} message
       * @param {object} [errorOptions]
       * @param {string} [errorOptions.code] - an id string representing the error
       * @param {number} [errorOptions.exitCode] - used with process.exit
       */
      error(message, errorOptions) {
        this._outputConfiguration.outputError(
          `${message}
`,
          this._outputConfiguration.writeErr
        );
        if (typeof this._showHelpAfterError === "string") {
          this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
        } else if (this._showHelpAfterError) {
          this._outputConfiguration.writeErr("\n");
          this.outputHelp({ error: true });
        }
        const config = errorOptions || {};
        const exitCode = config.exitCode || 1;
        const code = config.code || "commander.error";
        this._exit(exitCode, code, message);
      }
      /**
       * Apply any option related environment variables, if option does
       * not have a value from cli or client code.
       *
       * @private
       */
      _parseOptionsEnv() {
        this.options.forEach((option) => {
          if (option.envVar && option.envVar in process2.env) {
            const optionKey = option.attributeName();
            if (this.getOptionValue(optionKey) === void 0 || ["default", "config", "env"].includes(
              this.getOptionValueSource(optionKey)
            )) {
              if (option.required || option.optional) {
                this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
              } else {
                this.emit(`optionEnv:${option.name()}`);
              }
            }
          }
        });
      }
      /**
       * Apply any implied option values, if option is undefined or default value.
       *
       * @private
       */
      _parseOptionsImplied() {
        const dualHelper = new DualOptions(this.options);
        const hasCustomOptionValue = (optionKey) => {
          return this.getOptionValue(optionKey) !== void 0 && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
        };
        this.options.filter(
          (option) => option.implied !== void 0 && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(
            this.getOptionValue(option.attributeName()),
            option
          )
        ).forEach((option) => {
          Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
            this.setOptionValueWithSource(
              impliedKey,
              option.implied[impliedKey],
              "implied"
            );
          });
        });
      }
      /**
       * Argument `name` is missing.
       *
       * @param {string} name
       * @private
       */
      missingArgument(name) {
        const message = `error: missing required argument '${name}'`;
        this.error(message, { code: "commander.missingArgument" });
      }
      /**
       * `Option` is missing an argument.
       *
       * @param {Option} option
       * @private
       */
      optionMissingArgument(option) {
        const message = `error: option '${option.flags}' argument missing`;
        this.error(message, { code: "commander.optionMissingArgument" });
      }
      /**
       * `Option` does not have a value, and is a mandatory option.
       *
       * @param {Option} option
       * @private
       */
      missingMandatoryOptionValue(option) {
        const message = `error: required option '${option.flags}' not specified`;
        this.error(message, { code: "commander.missingMandatoryOptionValue" });
      }
      /**
       * `Option` conflicts with another option.
       *
       * @param {Option} option
       * @param {Option} conflictingOption
       * @private
       */
      _conflictingOption(option, conflictingOption) {
        const findBestOptionFromValue = (option2) => {
          const optionKey = option2.attributeName();
          const optionValue = this.getOptionValue(optionKey);
          const negativeOption = this.options.find(
            (target) => target.negate && optionKey === target.attributeName()
          );
          const positiveOption = this.options.find(
            (target) => !target.negate && optionKey === target.attributeName()
          );
          if (negativeOption && (negativeOption.presetArg === void 0 && optionValue === false || negativeOption.presetArg !== void 0 && optionValue === negativeOption.presetArg)) {
            return negativeOption;
          }
          return positiveOption || option2;
        };
        const getErrorMessage = (option2) => {
          const bestOption = findBestOptionFromValue(option2);
          const optionKey = bestOption.attributeName();
          const source = this.getOptionValueSource(optionKey);
          if (source === "env") {
            return `environment variable '${bestOption.envVar}'`;
          }
          return `option '${bestOption.flags}'`;
        };
        const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
        this.error(message, { code: "commander.conflictingOption" });
      }
      /**
       * Unknown option `flag`.
       *
       * @param {string} flag
       * @private
       */
      unknownOption(flag) {
        if (this._allowUnknownOption) return;
        let suggestion = "";
        if (flag.startsWith("--") && this._showSuggestionAfterError) {
          let candidateFlags = [];
          let command = this;
          do {
            const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
            candidateFlags = candidateFlags.concat(moreFlags);
            command = command.parent;
          } while (command && !command._enablePositionalOptions);
          suggestion = suggestSimilar(flag, candidateFlags);
        }
        const message = `error: unknown option '${flag}'${suggestion}`;
        this.error(message, { code: "commander.unknownOption" });
      }
      /**
       * Excess arguments, more than expected.
       *
       * @param {string[]} receivedArgs
       * @private
       */
      _excessArguments(receivedArgs) {
        if (this._allowExcessArguments) return;
        const expected = this.registeredArguments.length;
        const s = expected === 1 ? "" : "s";
        const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
        const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
        this.error(message, { code: "commander.excessArguments" });
      }
      /**
       * Unknown command.
       *
       * @private
       */
      unknownCommand() {
        const unknownName = this.args[0];
        let suggestion = "";
        if (this._showSuggestionAfterError) {
          const candidateNames = [];
          this.createHelp().visibleCommands(this).forEach((command) => {
            candidateNames.push(command.name());
            if (command.alias()) candidateNames.push(command.alias());
          });
          suggestion = suggestSimilar(unknownName, candidateNames);
        }
        const message = `error: unknown command '${unknownName}'${suggestion}`;
        this.error(message, { code: "commander.unknownCommand" });
      }
      /**
       * Get or set the program version.
       *
       * This method auto-registers the "-V, --version" option which will print the version number.
       *
       * You can optionally supply the flags and description to override the defaults.
       *
       * @param {string} [str]
       * @param {string} [flags]
       * @param {string} [description]
       * @return {(this | string | undefined)} `this` command for chaining, or version string if no arguments
       */
      version(str, flags, description) {
        if (str === void 0) return this._version;
        this._version = str;
        flags = flags || "-V, --version";
        description = description || "output the version number";
        const versionOption = this.createOption(flags, description);
        this._versionOptionName = versionOption.attributeName();
        this._registerOption(versionOption);
        this.on("option:" + versionOption.name(), () => {
          this._outputConfiguration.writeOut(`${str}
`);
          this._exit(0, "commander.version", str);
        });
        return this;
      }
      /**
       * Set the description.
       *
       * @param {string} [str]
       * @param {object} [argsDescription]
       * @return {(string|Command)}
       */
      description(str, argsDescription) {
        if (str === void 0 && argsDescription === void 0)
          return this._description;
        this._description = str;
        if (argsDescription) {
          this._argsDescription = argsDescription;
        }
        return this;
      }
      /**
       * Set the summary. Used when listed as subcommand of parent.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      summary(str) {
        if (str === void 0) return this._summary;
        this._summary = str;
        return this;
      }
      /**
       * Set an alias for the command.
       *
       * You may call more than once to add multiple aliases. Only the first alias is shown in the auto-generated help.
       *
       * @param {string} [alias]
       * @return {(string|Command)}
       */
      alias(alias) {
        if (alias === void 0) return this._aliases[0];
        let command = this;
        if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
          command = this.commands[this.commands.length - 1];
        }
        if (alias === command._name)
          throw new Error("Command alias can't be the same as its name");
        const matchingCommand = this.parent?._findCommand(alias);
        if (matchingCommand) {
          const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
          throw new Error(
            `cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`
          );
        }
        command._aliases.push(alias);
        return this;
      }
      /**
       * Set aliases for the command.
       *
       * Only the first alias is shown in the auto-generated help.
       *
       * @param {string[]} [aliases]
       * @return {(string[]|Command)}
       */
      aliases(aliases) {
        if (aliases === void 0) return this._aliases;
        aliases.forEach((alias) => this.alias(alias));
        return this;
      }
      /**
       * Set / get the command usage `str`.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      usage(str) {
        if (str === void 0) {
          if (this._usage) return this._usage;
          const args = this.registeredArguments.map((arg) => {
            return humanReadableArgName(arg);
          });
          return [].concat(
            this.options.length || this._helpOption !== null ? "[options]" : [],
            this.commands.length ? "[command]" : [],
            this.registeredArguments.length ? args : []
          ).join(" ");
        }
        this._usage = str;
        return this;
      }
      /**
       * Get or set the name of the command.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      name(str) {
        if (str === void 0) return this._name;
        this._name = str;
        return this;
      }
      /**
       * Set the name of the command from script filename, such as process.argv[1],
       * or require.main.filename, or __filename.
       *
       * (Used internally and public although not documented in README.)
       *
       * @example
       * program.nameFromFilename(require.main.filename);
       *
       * @param {string} filename
       * @return {Command}
       */
      nameFromFilename(filename) {
        this._name = path.basename(filename, path.extname(filename));
        return this;
      }
      /**
       * Get or set the directory for searching for executable subcommands of this command.
       *
       * @example
       * program.executableDir(__dirname);
       * // or
       * program.executableDir('subcommands');
       *
       * @param {string} [path]
       * @return {(string|null|Command)}
       */
      executableDir(path2) {
        if (path2 === void 0) return this._executableDir;
        this._executableDir = path2;
        return this;
      }
      /**
       * Return program help documentation.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to wrap for stderr instead of stdout
       * @return {string}
       */
      helpInformation(contextOptions) {
        const helper = this.createHelp();
        const context = this._getOutputContext(contextOptions);
        helper.prepareContext({
          error: context.error,
          helpWidth: context.helpWidth,
          outputHasColors: context.hasColors
        });
        const text = helper.formatHelp(this, helper);
        if (context.hasColors) return text;
        return this._outputConfiguration.stripColor(text);
      }
      /**
       * @typedef HelpContext
       * @type {object}
       * @property {boolean} error
       * @property {number} helpWidth
       * @property {boolean} hasColors
       * @property {function} write - includes stripColor if needed
       *
       * @returns {HelpContext}
       * @private
       */
      _getOutputContext(contextOptions) {
        contextOptions = contextOptions || {};
        const error = !!contextOptions.error;
        let baseWrite;
        let hasColors;
        let helpWidth;
        if (error) {
          baseWrite = (str) => this._outputConfiguration.writeErr(str);
          hasColors = this._outputConfiguration.getErrHasColors();
          helpWidth = this._outputConfiguration.getErrHelpWidth();
        } else {
          baseWrite = (str) => this._outputConfiguration.writeOut(str);
          hasColors = this._outputConfiguration.getOutHasColors();
          helpWidth = this._outputConfiguration.getOutHelpWidth();
        }
        const write = (str) => {
          if (!hasColors) str = this._outputConfiguration.stripColor(str);
          return baseWrite(str);
        };
        return { error, write, hasColors, helpWidth };
      }
      /**
       * Output help information for this command.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean } | Function} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      outputHelp(contextOptions) {
        let deprecatedCallback;
        if (typeof contextOptions === "function") {
          deprecatedCallback = contextOptions;
          contextOptions = void 0;
        }
        const outputContext = this._getOutputContext(contextOptions);
        const eventContext = {
          error: outputContext.error,
          write: outputContext.write,
          command: this
        };
        this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
        this.emit("beforeHelp", eventContext);
        let helpInformation = this.helpInformation({ error: outputContext.error });
        if (deprecatedCallback) {
          helpInformation = deprecatedCallback(helpInformation);
          if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
            throw new Error("outputHelp callback must return a string or a Buffer");
          }
        }
        outputContext.write(helpInformation);
        if (this._getHelpOption()?.long) {
          this.emit(this._getHelpOption().long);
        }
        this.emit("afterHelp", eventContext);
        this._getCommandAndAncestors().forEach(
          (command) => command.emit("afterAllHelp", eventContext)
        );
      }
      /**
       * You can pass in flags and a description to customise the built-in help option.
       * Pass in false to disable the built-in help option.
       *
       * @example
       * program.helpOption('-?, --help' 'show help'); // customise
       * program.helpOption(false); // disable
       *
       * @param {(string | boolean)} flags
       * @param {string} [description]
       * @return {Command} `this` command for chaining
       */
      helpOption(flags, description) {
        if (typeof flags === "boolean") {
          if (flags) {
            this._helpOption = this._helpOption ?? void 0;
          } else {
            this._helpOption = null;
          }
          return this;
        }
        flags = flags ?? "-h, --help";
        description = description ?? "display help for command";
        this._helpOption = this.createOption(flags, description);
        return this;
      }
      /**
       * Lazy create help option.
       * Returns null if has been disabled with .helpOption(false).
       *
       * @returns {(Option | null)} the help option
       * @package
       */
      _getHelpOption() {
        if (this._helpOption === void 0) {
          this.helpOption(void 0, void 0);
        }
        return this._helpOption;
      }
      /**
       * Supply your own option to use for the built-in help option.
       * This is an alternative to using helpOption() to customise the flags and description etc.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addHelpOption(option) {
        this._helpOption = option;
        return this;
      }
      /**
       * Output help information and exit.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      help(contextOptions) {
        this.outputHelp(contextOptions);
        let exitCode = Number(process2.exitCode ?? 0);
        if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
          exitCode = 1;
        }
        this._exit(exitCode, "commander.help", "(outputHelp)");
      }
      /**
       * // Do a little typing to coordinate emit and listener for the help text events.
       * @typedef HelpTextEventContext
       * @type {object}
       * @property {boolean} error
       * @property {Command} command
       * @property {function} write
       */
      /**
       * Add additional text to be displayed with the built-in help.
       *
       * Position is 'before' or 'after' to affect just this command,
       * and 'beforeAll' or 'afterAll' to affect this command and all its subcommands.
       *
       * @param {string} position - before or after built-in help
       * @param {(string | Function)} text - string to add, or a function returning a string
       * @return {Command} `this` command for chaining
       */
      addHelpText(position, text) {
        const allowedValues = ["beforeAll", "before", "after", "afterAll"];
        if (!allowedValues.includes(position)) {
          throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        const helpEvent = `${position}Help`;
        this.on(helpEvent, (context) => {
          let helpStr;
          if (typeof text === "function") {
            helpStr = text({ error: context.error, command: context.command });
          } else {
            helpStr = text;
          }
          if (helpStr) {
            context.write(`${helpStr}
`);
          }
        });
        return this;
      }
      /**
       * Output help information if help flags specified
       *
       * @param {Array} args - array of options to search for help flags
       * @private
       */
      _outputHelpIfRequested(args) {
        const helpOption = this._getHelpOption();
        const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
        if (helpRequested) {
          this.outputHelp();
          this._exit(0, "commander.helpDisplayed", "(outputHelp)");
        }
      }
    };
    function incrementNodeInspectorPort(args) {
      return args.map((arg) => {
        if (!arg.startsWith("--inspect")) {
          return arg;
        }
        let debugOption;
        let debugHost = "127.0.0.1";
        let debugPort = "9229";
        let match;
        if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
          debugOption = match[1];
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
          debugOption = match[1];
          if (/^\d+$/.test(match[3])) {
            debugPort = match[3];
          } else {
            debugHost = match[3];
          }
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
          debugOption = match[1];
          debugHost = match[3];
          debugPort = match[4];
        }
        if (debugOption && debugPort !== "0") {
          return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
        }
        return arg;
      });
    }
    function useColor() {
      if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
        return false;
      if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== void 0)
        return true;
      return void 0;
    }
    exports.Command = Command2;
    exports.useColor = useColor;
  }
});

// node_modules/commander/index.js
var require_commander = __commonJS({
  "node_modules/commander/index.js"(exports) {
    var { Argument: Argument2 } = require_argument();
    var { Command: Command2 } = require_command();
    var { CommanderError: CommanderError2, InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var { Help: Help2 } = require_help();
    var { Option: Option2 } = require_option();
    exports.program = new Command2();
    exports.createCommand = (name) => new Command2(name);
    exports.createOption = (flags, description) => new Option2(flags, description);
    exports.createArgument = (name, description) => new Argument2(name, description);
    exports.Command = Command2;
    exports.Option = Option2;
    exports.Argument = Argument2;
    exports.Help = Help2;
    exports.CommanderError = CommanderError2;
    exports.InvalidArgumentError = InvalidArgumentError2;
    exports.InvalidOptionArgumentError = InvalidArgumentError2;
  }
});

// node_modules/commander/esm.mjs
var import_index = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  // deprecated old name
  Command,
  Argument,
  Option,
  Help
} = import_index.default;

// src/cli.js
import { readFileSync as readFileSync3, writeFileSync } from "node:fs";

// src/session.js
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var APP_BUNDLE = process.env.GROKBOT_APP_BUNDLE || "/Applications/Grok Bot.app";
var APP_SUPPORT = process.env.GROKBOT_APP_SUPPORT || join(homedir(), "Library/Application Support/Grok Bot");
var GROKBOT_HOME = process.env.GROKBOT_HOME || join(homedir(), ".grokbot");
var CURSOR_API = (process.env.GROKBOT_CURSOR_API || "https://api2.cursor.sh").replace(/\/$/, "");
var KEYCHAIN_SERVICE = "Grok Bot Safe Storage";
var DESCRIPTOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SessionError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.exitCode = 2;
  }
};
var cachedKey = null;
function readKeychainPassword() {
  if (process.env.GROKBOT_SAFE_STORAGE_PASSWORD) return process.env.GROKBOT_SAFE_STORAGE_PASSWORD;
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trimEnd();
  } catch (err) {
    throw new SessionError(
      "KEYCHAIN_DENIED",
      `Could not read the "${KEYCHAIN_SERVICE}" Keychain item (macOS asks for your Mac login password; choose "Always Allow").`
    );
  }
}
function safeStorageKey(password = null) {
  if (password == null && cachedKey) return cachedKey;
  const key = crypto.pbkdf2Sync(password ?? readKeychainPassword(), "saltysalt", 1003, 16, "sha1");
  if (password == null) cachedKey = key;
  return key;
}
function decryptSafeStorage(ciphertextBase64, key = null) {
  const buf = Buffer.from(ciphertextBase64, "base64");
  const prefix = buf.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") {
    throw new SessionError("UNSUPPORTED_CIPHERTEXT", `Unsupported safeStorage prefix ${JSON.stringify(prefix)}`);
  }
  const decipher = crypto.createDecipheriv("aes-128-cbc", key ?? safeStorageKey(), Buffer.alloc(16, 32));
  return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString("utf8");
}
function descriptorPath() {
  return join(APP_SUPPORT, "gateway-descriptor.json");
}
function parseDescriptorFile(json, { accountScope = null, decrypt = decryptSafeStorage } = {}) {
  const wrapped = typeof json === "string" ? JSON.parse(json) : json;
  let entries;
  if (wrapped.version === 2) {
    entries = Object.entries(wrapped.entries ?? {}).filter(([, v]) => v && typeof v.encrypted === "string");
  } else if (typeof wrapped.encrypted === "string") {
    entries = [["default", { encrypted: wrapped.encrypted, savedAtMs: 0 }]];
  } else {
    entries = [];
  }
  if (accountScope) entries = entries.filter(([scope2]) => scope2 === accountScope);
  if (entries.length === 0) return null;
  entries.sort((a, b) => (b[1].savedAtMs ?? 0) - (a[1].savedAtMs ?? 0));
  const [scope, entry] = entries[0];
  const desc = JSON.parse(decrypt(entry.encrypted));
  if (!desc.baseUrl || !desc.token) {
    throw new SessionError("INCOMPLETE_DESCRIPTOR", "Decrypted gateway descriptor is missing baseUrl or token.");
  }
  return {
    source: "descriptor",
    accountScope: scope,
    savedAtMs: entry.savedAtMs ?? null,
    entryCount: Object.keys(wrapped.entries ?? {}).length || 1,
    baseUrl: String(desc.baseUrl).replace(/\/$/, ""),
    token: String(desc.token),
    headers: normalizeHeaders(desc.headers),
    vncProxy: desc.vncProxy ?? null
  };
}
function loadGatewayDescriptor(opts = {}) {
  const p = descriptorPath();
  if (!existsSync(p)) return null;
  return parseDescriptorFile(readFileSync(p, "utf8"), opts);
}
function normalizeHeaders(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out2 = {};
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== "") out2[String(k).toLowerCase()] = String(v);
  return out2;
}
function unscope(value) {
  if (!value.startsWith("scoped:v1:")) return value;
  const i = value.indexOf(":", "scoped:v1:".length);
  return i < 0 ? value : value.slice(i + 1);
}
function readSecretValue(value, key = null) {
  if (value == null) return null;
  if (value.startsWith("plaintext:v1:")) return Buffer.from(value.slice("plaintext:v1:".length), "base64").toString("utf8");
  return decryptSafeStorage(unscope(value), key);
}
function secretsPath() {
  return join(APP_SUPPORT, "sand-secrets.json");
}
function loadCursorAuth({ accountScope = null, key = null } = {}) {
  const p = secretsPath();
  if (!existsSync(p)) return null;
  const secrets = JSON.parse(readFileSync(p, "utf8"));
  const record = secrets["cursor-accounts"] ? JSON.parse(secrets["cursor-accounts"]) : { active: null, accounts: {} };
  const scope = accountScope ?? record.active ?? null;
  const acct = scope ? record.accounts?.[scope] ?? null : null;
  const accessToken = readSecretValue(acct?.["cursor-access-token"] ?? secrets["cursor-access-token"] ?? null, key);
  if (!accessToken) return null;
  const refreshToken = readSecretValue(acct?.["cursor-refresh-token"] ?? secrets["cursor-refresh-token"] ?? null, key);
  const profileRaw = readSecretValue(acct?.["cursor-account-profile"] ?? null, key);
  let profile = {};
  try {
    profile = profileRaw ? JSON.parse(profileRaw) : {};
  } catch {
    profile = {};
  }
  const optional = (v) => {
    try {
      return readSecretValue(v, key);
    } catch {
      return null;
    }
  };
  const teamId = optional(secrets["cursor-selected-team-id"] ?? null);
  return {
    accountScope: scope,
    accounts: Object.keys(record.accounts ?? {}),
    accessToken,
    refreshToken,
    profile,
    teamId: teamId ? Number(teamId) || null : null,
    machineId: optional(secrets["cursor-machine-id"] ?? null)
  };
}
function jwtClaims(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
var cachedAppVersion;
function appVersion() {
  if (cachedAppVersion !== void 0) return cachedAppVersion;
  try {
    cachedAppVersion = execFileSync("/usr/bin/defaults", ["read", join(APP_BUNDLE, "Contents/Info"), "CFBundleShortVersionString"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || null;
  } catch {
    cachedAppVersion = null;
  }
  return cachedAppVersion;
}
function cursorHeaders(accessToken, extra = {}) {
  return {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    authorization: `Bearer ${accessToken}`,
    "x-cursor-client-type": "sand",
    "x-cursor-client-version": process.env.GROKBOT_CLIENT_VERSION || appVersion() || "0.47.0",
    "x-sand-box-namespace": process.env.SAND_BOX_NAMESPACE || "prod",
    ...extra
  };
}
async function ensureSandBox(auth, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${CURSOR_API}/aiserver.v1.GrokBotService/EnsureSandBox`, {
    method: "POST",
    headers: cursorHeaders(auth.accessToken),
    body: "{}"
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new SessionError("ENSURE_SANDBOX_FAILED", `EnsureSandBox ${res.status}: ${body.message ?? body.raw ?? res.statusText}`);
  }
  const baseUrl = body.gatewayUrl ?? body.gateway_url;
  const token = body.gatewayToken ?? body.gateway_token;
  if (!baseUrl || !token) {
    throw new SessionError("ENSURE_SANDBOX_EMPTY", "EnsureSandBox returned no gateway url/token.");
  }
  let headers = normalizeHeaders(body.gatewayHeaders ?? body.gateway_headers);
  const net = body.anyrunNetworkToken ?? body.anyrun_network_token ?? body.networkToken;
  if (Object.keys(headers).length === 0 && net) headers = { "x-anyrun-network-token": String(net) };
  return { source: "ensure-sandbox", accountScope: auth.accountScope, baseUrl: String(baseUrl).replace(/\/$/, ""), token: String(token), headers };
}
function boxGatewayCandidates(env = process.env) {
  return [
    env.SAND_DATA_ROOT ? join(env.SAND_DATA_ROOT, "gateway.json") : null,
    env.GROKBOT_BOX_GATEWAY_JSON || null,
    "/home/box/agent-data/gateway.json",
    "/home/box/sand-data/gateway.json",
    join(homedir(), "agent-data/gateway.json"),
    join(homedir(), "sand-data/gateway.json")
  ].filter(Boolean);
}
function boxGatewaySession(env = process.env) {
  for (const p of boxGatewayCandidates(env)) {
    if (!existsSync(p)) continue;
    let d;
    try {
      d = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (!d?.token || !d?.port) continue;
    const scheme = d.scheme || "http";
    return { source: "box", accountScope: null, baseUrl: `${scheme}://127.0.0.1:${d.port}`, token: String(d.token), headers: {}, path: p };
  }
  return null;
}
function isInsideBox(env = process.env) {
  return boxGatewaySession(env) != null;
}
function envGatewaySession() {
  const url = process.env.GROKBOT_GATEWAY_URL;
  const token = process.env.GROKBOT_GATEWAY_TOKEN;
  if (!url || !token) return null;
  let headers = {};
  if (process.env.GROKBOT_GATEWAY_HEADERS) headers = normalizeHeaders(JSON.parse(process.env.GROKBOT_GATEWAY_HEADERS));
  return { source: "env", accountScope: null, baseUrl: url.replace(/\/$/, ""), token, headers };
}
async function resolveGatewaySession({ accountScope = null, prefer = "auto", fetchImpl = fetch } = {}) {
  const fromEnv = envGatewaySession();
  if (fromEnv) return fromEnv;
  const fromBox = boxGatewaySession();
  if (fromBox) return fromBox;
  if (prefer !== "ensure") {
    const desc = loadGatewayDescriptor({ accountScope });
    if (desc) {
      const fresh = desc.savedAtMs == null || Date.now() - desc.savedAtMs < DESCRIPTOR_MAX_AGE_MS;
      if (fresh || prefer === "descriptor") return desc;
    }
  }
  const auth = loadCursorAuth({ accountScope });
  if (auth?.accessToken) return ensureSandBox(auth, { fetchImpl });
  throw new SessionError(
    "NO_SESSION",
    "No Grok Bot session found. On a Mac: open Grok Bot and sign in once. Inside a box: /home/box/agent-data/gateway.json must exist. Or set GROKBOT_GATEWAY_URL + GROKBOT_GATEWAY_TOKEN."
  );
}
function describeSessionSources() {
  const out2 = { appBundle: existsSync(APP_BUNDLE), appVersion: appVersion(), descriptor: null, secrets: null, home: null };
  const dp = descriptorPath();
  if (existsSync(dp)) {
    const st = statSync(dp);
    let wrapped = null;
    try {
      wrapped = JSON.parse(readFileSync(dp, "utf8"));
    } catch {
    }
    out2.descriptor = { path: dp, modifiedAt: st.mtime.toISOString(), version: wrapped?.version ?? null, entries: wrapped?.entries ? Object.keys(wrapped.entries).length : wrapped?.encrypted ? 1 : 0 };
  }
  const sp = secretsPath();
  if (existsSync(sp)) {
    let keys = [];
    try {
      keys = Object.keys(JSON.parse(readFileSync(sp, "utf8")));
    } catch {
    }
    out2.secrets = { path: sp, keys };
  }
  if (existsSync(GROKBOT_HOME)) out2.home = GROKBOT_HOME;
  return out2;
}
var SECRET_FRAGMENTS = "token|secret|password|credential|authorization|api[-_]?key|cookie";
var SECRET_KEY_RE = new RegExp(`"([^"]*(?:${SECRET_FRAGMENTS})[^"]*)"\\s*:\\s*"[^"]*"`, "gi");
function redact(text) {
  return String(text).replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer <redacted>").replace(SECRET_KEY_RE, '"$1":"<redacted>"').replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt-redacted>");
}
function redactValue(value) {
  const re = new RegExp(SECRET_FRAGMENTS, "i");
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, re.test(k) ? "<redacted>" : walk(x)]));
    if (typeof v === "string") return redact(v);
    return v;
  };
  return walk(value);
}

// src/cursor.js
var CursorRpcError = class extends Error {
  constructor(message, extra = {}) {
    super(redact(message));
    this.name = "CursorRpcError";
    Object.assign(this, extra, extra.data !== void 0 ? { data: redactValue(extra.data) } : {});
    this.exitCode = extra.status === 401 ? 2 : 1;
  }
};
var CursorClient = class {
  constructor(auth, { fetchImpl = fetch, service = "aiserver.v1.GrokBotService", baseUrl = CURSOR_API } = {}) {
    if (!auth?.accessToken) throw new CursorRpcError("No Cursor access token available (sign in to Grok Bot first).");
    this.auth = auth;
    this.fetch = fetchImpl;
    this.service = service;
    this.baseUrl = baseUrl;
  }
  tokenInfo() {
    const claims = jwtClaims(this.auth.accessToken) ?? {};
    const expMs = claims.exp ? claims.exp * 1e3 : null;
    return {
      accountScope: this.auth.accountScope,
      email: this.auth.profile?.email ?? null,
      name: this.auth.profile?.name ?? null,
      subject: claims.sub ?? null,
      issuer: claims.iss ?? null,
      audience: claims.aud ?? null,
      type: claims.type ?? null,
      expiresAt: expMs ? new Date(expMs).toISOString() : null,
      expired: expMs ? expMs < Date.now() : null,
      hasRefreshToken: Boolean(this.auth.refreshToken),
      teamId: this.auth.teamId ?? null
    };
  }
  async rpc(method, body = {}, { service = this.service, headers = {} } = {}) {
    const url = `${this.baseUrl}/${service}/${method}`;
    const extra = { ...headers };
    if (this.auth.teamId && !extra["x-cursor-team-id"]) extra["x-cursor-team-id"] = String(this.auth.teamId);
    const res = await this.fetch(url, { method: "POST", headers: cursorHeaders(this.auth.accessToken, extra), body: JSON.stringify(body ?? {}) });
    const text = await res.text();
    let data;
    try {
      data = text === "" ? {} : JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const detail = data?.details?.[0]?.debug?.details?.detail ?? data?.message ?? data?.raw ?? res.statusText;
      throw new CursorRpcError(`${method} failed: ${res.status} ${data?.code ?? ""} ${String(detail).slice(0, 300)}`.trim(), { status: res.status, method, data });
    }
    return data;
  }
  async listAgents({ includeTeamAgents = true, role } = {}) {
    const r = await this.rpc("ListGrokBotAgents", { includeTeamAgents, ...role ? { role } : {} });
    return { agents: r.agents ?? [], slackConnections: r.slackConnections ?? [] };
  }
  deleteAgent(id) {
    return this.rpc("DeleteGrokBotAgent", { id });
  }
  updateAgent(id, patch) {
    return this.rpc("UpdateGrokBotAgent", { id, ...patch });
  }
  setVisibility(agentId, visibility) {
    return this.rpc("SetGrokBotAgentVisibility", { agentId, visibility });
  }
  listSessions(agentId) {
    return this.rpc("ListGrokBotAgentSessions", { agentId });
  }
  listTeamAgents() {
    return this.rpc("AdminListGrokBotTeamAgents", {});
  }
  listBoxes() {
    return this.rpc("ListSandBoxes", {});
  }
  runState() {
    return this.rpc("GetSandBoxRunState", {});
  }
  ensureSandBox() {
    return this.rpc("EnsureSandBox", {});
  }
  listTemplates() {
    return this.rpc("ListGrokBotTemplates", {});
  }
  listUserComputers() {
    return this.rpc("ListGrokBotUserComputers", {});
  }
  // Sidebar sections live in the per-user runtime settings on the control plane (the app no longer reads host settings).
  async getSidebarSections() {
    const r = await this.rpc("GetGrokBotUserRuntimeSettings", {});
    const sections = r?.settings?.sidebarSections?.sections;
    return Array.isArray(sections) ? sections : [];
  }
  // `base` is the optimistic-concurrency check (the sections we read before editing); omitted when not provided.
  async setSidebarSections(sections, base) {
    const body = { sidebarSections: { sections } };
    if (base !== void 0 && base !== null) body.sidebarSectionsBase = { sections: base };
    const r = await this.rpc("UpdateGrokBotUserRuntimeSettings", body);
    const stored = r?.settings?.sidebarSections?.sections;
    if (!Array.isArray(stored)) throw new CursorRpcError("UpdateGrokBotUserRuntimeSettings returned no sidebarSections", { method: "UpdateGrokBotUserRuntimeSettings", data: r });
    return stored;
  }
  runtimeCapabilities() {
    return this.rpc("GetGrokBotRuntimeCapabilities", {});
  }
};

// src/cdp.js
import { execFile, execFileSync as execFileSync2 } from "node:child_process";
import { promisify } from "node:util";
var execFileP = promisify(execFile);
var DEFAULT_CDP_PORT = Number(process.env.GROKBOT_CDP_PORT || 9340);
var APP_PROCESS_NAME = "Grok Bot";
var CdpError = class extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "CdpError";
    Object.assign(this, extra);
  }
};
var MAX_TIMER_MS = 2 ** 31 - 1;
async function cdpVersion(port = DEFAULT_CDP_PORT, { timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
async function cdpTargets(port = DEFAULT_CDP_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3e3) });
  if (!res.ok) throw new CdpError(`CDP /json returned ${res.status}`);
  return res.json();
}
function appPids() {
  try {
    const out2 = execFileSync2("/usr/bin/pgrep", ["-x", APP_PROCESS_NAME], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out2.split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
function appArgs(pid) {
  try {
    return execFileSync2("/bin/ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
async function appState(port = DEFAULT_CDP_PORT) {
  const pids = appPids();
  const main = pids.find((p) => appArgs(p).includes(`${APP_BUNDLE}/Contents/MacOS/`)) ?? pids[0] ?? null;
  const args = main ? appArgs(main) : "";
  const m = args.match(/--remote-debugging-port=(\d+)/);
  const debugPort = m ? Number(m[1]) : null;
  const version = debugPort ? await cdpVersion(debugPort) : await cdpVersion(port);
  return { running: pids.length > 0, pid: main, debugPort: debugPort ?? (version ? port : null), cdpReachable: Boolean(version), version };
}
async function quitApp({ timeoutMs = 2e4 } = {}) {
  if (appPids().length === 0) return true;
  await execFileP("/usr/bin/osascript", ["-e", `quit app "${APP_PROCESS_NAME}"`]).catch(() => {
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appPids().length === 0) return true;
    await sleep(300);
  }
  return appPids().length === 0;
}
async function launchApp({ debugPort = null, timeoutMs = 3e4 } = {}) {
  const args = ["-a", APP_BUNDLE];
  if (debugPort) args.push("--args", `--remote-debugging-port=${debugPort}`, `--remote-allow-origins=http://127.0.0.1:${debugPort}`);
  await execFileP("/usr/bin/open", args);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (debugPort) {
      if (await cdpVersion(debugPort)) return true;
    } else if (appPids().length > 0) return true;
    await sleep(400);
  }
  return false;
}
async function ensureDebugApp({ port = DEFAULT_CDP_PORT, restart = false } = {}) {
  const state = await appState(port);
  if (state.cdpReachable && !restart) return { ...state, relaunched: false };
  if (state.running) {
    const quit = await quitApp();
    if (!quit) throw new CdpError("Grok Bot did not quit within 20s; close it manually and retry.");
  }
  const ok = await launchApp({ debugPort: port });
  if (!ok) throw new CdpError(`Grok Bot did not expose CDP on port ${port} within 30s.`);
  return { ...await appState(port), relaunched: true };
}
var DEFAULT_SEND_TIMEOUT_MS = 3e4;
var SLOW_CALL_TIMEOUT_MS = 12e4;
var SLOW_DESKTOP_PATH = /(restart|relaunch|reload|quit|update|install|signin|signout|login|logout|authenticate|boxhost)/i;
var Cdp = class _Cdp {
  constructor(ws, { timeoutMs = DEFAULT_SEND_TIMEOUT_MS } = {}) {
    this.ws = ws;
    this.id = 0;
    this.timeoutMs = timeoutMs;
    this.pending = /* @__PURE__ */ new Map();
    this.listeners = /* @__PURE__ */ new Set();
    this.closed = false;
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.settle(msg);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    };
    ws.onclose = () => this.rejectAll(new CdpError("CDP websocket closed"));
    ws.onerror = (e) => this.rejectAll(new CdpError(`CDP websocket error: ${e?.message ?? "error"}`));
  }
  /** Reject every in-flight call (socket closed/errored) and refuse new ones. */
  rejectAll(err) {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }
  static async connect({ port = DEFAULT_CDP_PORT, target = "page" } = {}) {
    const targets = await cdpTargets(port).catch((err) => {
      throw new CdpError(`Grok Bot is not exposing CDP on port ${port} (${err.message}). Run \`grokbot app restart --debug\`.`);
    });
    const t = targets.find((x) => x.type === target && /app\.asar\/dist\/renderer/.test(x.url)) ?? targets.find((x) => x.type === target);
    if (!t) throw new CdpError(`No ${target} target found on CDP port ${port}.`);
    if (typeof WebSocket === "undefined") throw new CdpError("CDP needs Node 22+ (global WebSocket); it only applies on the Mac that runs the desktop app.");
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new CdpError(`CDP websocket failed: ${e?.message ?? "error"}`));
    });
    const cdp = new _Cdp(ws);
    cdp.target = t;
    return cdp;
  }
  send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    timeoutMs = Math.min(timeoutMs, MAX_TIMER_MS);
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new CdpError(`${method}: CDP websocket is closed`));
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { timer, reject, settle: (msg) => msg.error ? reject(new CdpError(`${method}: ${msg.error.message}`)) : resolve(msg.result) });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${method}: ${err.message}`));
      }
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, timeoutMs ? { timeoutMs } : {});
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new CdpError(`renderer threw: ${String(d).split("\n")[0]}`);
    }
    return r.result?.value;
  }
  /** Call a method on window.desktop by dotted path, e.g. "agent.getSidebarSections". */
  callDesktop(path, args = [], { timeoutMs } = {}) {
    const expr = `window.desktop.${path}(...${JSON.stringify(args)})`;
    const t = timeoutMs ?? (SLOW_DESKTOP_PATH.test(path) ? Math.max(SLOW_CALL_TIMEOUT_MS, this.timeoutMs) : void 0);
    return this.evaluate(expr, { timeoutMs: t });
  }
  desktopKeys(path = "") {
    return this.evaluate(`Object.keys(window.desktop${path ? "." + path : ""})`);
  }
  bringToFront() {
    return this.send("Page.bringToFront");
  }
  pageText() {
    return this.evaluate("document.body.innerText");
  }
  async screenshot(path, { format = "png" } = {}) {
    const { writeFileSync: writeFileSync2 } = await import("node:fs");
    const r = await this.send("Page.captureScreenshot", { format });
    writeFileSync2(path, Buffer.from(r.data, "base64"));
    return path;
  }
  close() {
    try {
      this.ws.close();
    } catch {
    }
  }
};
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/gateway.js
import { randomUUID } from "node:crypto";

// src/output.js
function printJson(value, { redactSecrets = true } = {}) {
  const text = JSON.stringify(value, null, 2);
  process.stdout.write((redactSecrets ? redact(text) : text) + "\n");
}
function table(rows, columns, { maxWidth = process.stdout.columns || 160 } = {}) {
  if (rows.length === 0) return "(none)\n";
  const cols = columns.map((c) => typeof c === "string" ? { key: c, label: c } : c);
  const cells = rows.map((r) => cols.map((c) => fmtCell(c.get ? c.get(r) : r[c.key], c)));
  const widths = cols.map((c, i) => Math.min(c.max ?? 60, Math.max(c.label.length, ...cells.map((row) => row[i].length))));
  const line = (arr) => arr.map((v, i) => pad(v, widths[i])).join("  ").trimEnd();
  const out2 = [line(cols.map((c) => c.label)), line(widths.map((w) => "-".repeat(w)))];
  for (const row of cells) out2.push(line(row));
  return out2.map((l) => l.length > maxWidth ? l.slice(0, maxWidth - 1) + "\u2026" : l).join("\n") + "\n";
}
function pad(v, w) {
  if (v.length > w) return v.slice(0, Math.max(0, w - 1)) + "\u2026";
  return v.padEnd(w);
}
function fmtCell(v, col) {
  if (v == null) return "";
  if (col.format) return String(col.format(v));
  if (typeof v === "boolean") return v ? "yes" : "";
  if (Array.isArray(v)) return v.join(",");
  return String(v).replace(/\s+/g, " ");
}
function relTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - Number(ms);
  const abs = Math.abs(diff);
  const units = [
    [6e4, "s", 1e3],
    [36e5, "m", 6e4],
    [864e5, "h", 36e5],
    [7 * 864e5, "d", 864e5],
    [Infinity, "w", 7 * 864e5]
  ];
  for (const [limit, label, div] of units) {
    if (abs < limit) return `${Math.floor(abs / div)}${label}${diff < 0 ? " ahead" : ""}`;
  }
  return "";
}
function shortId(id, n = 8) {
  return id ? String(id).slice(0, n) : "";
}
function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
var UsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 64;
  }
};

// src/sections.js
function normalizeSections(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out2 = [];
  for (const s of raw) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.name !== "string") continue;
    const agentIds = [];
    for (const id of Array.isArray(s.agentIds) ? s.agentIds : []) {
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        agentIds.push(id);
      }
    }
    const section = { ...s, id: s.id, name: s.name, agentIds };
    if (typeof s.isCollapsed !== "boolean") delete section.isCollapsed;
    out2.push(section);
  }
  return out2;
}
function newSectionId(now = Date.now(), n = Math.floor(Math.random() * 90) + 10) {
  return `section-${now.toString(36)}-${n}`;
}
function findSection(sections, ref) {
  if (!ref) return null;
  const exact = sections.find((s) => s.id === ref);
  if (exact) return exact;
  const byName = sections.filter((s) => s.name.toLowerCase() === String(ref).toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new UsageError(`Section name "${ref}" is ambiguous (${byName.map((s) => s.id).join(", ")}); use the id.`);
  const partial = sections.filter((s) => s.name.toLowerCase().includes(String(ref).toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new UsageError(`Section "${ref}" matches ${partial.length} sections: ${partial.map((s) => s.name).join(", ")}`);
  return null;
}
function requireSection(sections, ref) {
  const s = findSection(sections, ref);
  if (!s) throw new UsageError(`No section matches "${ref}". Known: ${sections.map((s2) => s2.name).join(", ") || "(none)"}`);
  return s;
}
function createSection(sections, name, agentIds = [], { id = newSectionId(), position = null } = {}) {
  const clean = String(name).trim();
  if (!clean) throw new UsageError("Section name cannot be blank.");
  if (sections.some((s) => s.name.toLowerCase() === clean.toLowerCase())) throw new UsageError(`Section "${clean}" already exists.`);
  const next = assignAgents(sections, null, agentIds);
  const section = { id, name: clean, agentIds: [...new Set(agentIds)] };
  if (position == null || position >= next.length) next.push(section);
  else next.splice(Math.max(0, position), 0, section);
  return { sections: next, section };
}
function renameSection(sections, ref, name) {
  const target = requireSection(sections, ref);
  if (BUILTIN_SECTION_IDS.has(target.id)) throw new UsageError(`"${target.name}" is the app's built-in bucket and cannot be renamed.`);
  const clean = String(name).trim();
  if (!clean) throw new UsageError("Section name cannot be blank.");
  if (sections.some((s) => s.id !== target.id && s.name.toLowerCase() === clean.toLowerCase())) throw new UsageError(`Section "${clean}" already exists.`);
  return { sections: sections.map((s) => s.id === target.id ? { ...s, name: clean } : s), section: { ...target, name: clean } };
}
var BUILTIN_SECTION_IDS = /* @__PURE__ */ new Set(["__agents__"]);
function deleteSection(sections, ref) {
  const target = requireSection(sections, ref);
  if (BUILTIN_SECTION_IDS.has(target.id)) throw new UsageError(`"${target.name}" is the app's built-in bucket and cannot be deleted.`);
  return { sections: sections.filter((s) => s.id !== target.id), section: target, released: target.agentIds };
}
function assignAgents(sections, ref, agentIds) {
  const target = ref == null ? null : requireSection(sections, ref);
  const ids = new Set(agentIds);
  return sections.map((s) => {
    const kept = s.agentIds.filter((id) => !ids.has(id));
    if (target && s.id === target.id) return { ...s, agentIds: [...kept, ...agentIds.filter((id, i, arr) => arr.indexOf(id) === i)] };
    return { ...s, agentIds: kept };
  });
}
function moveSection(sections, ref, position) {
  const target = requireSection(sections, ref);
  const rest = sections.filter((s) => s.id !== target.id);
  const idx = Math.min(Math.max(0, position), rest.length);
  rest.splice(idx, 0, target);
  return rest;
}
function sortSections(sections, { by = "name" } = {}) {
  const copy = [...sections];
  if (by === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (by === "size") copy.sort((a, b) => b.agentIds.length - a.agentIds.length);
  return copy;
}
function pruneSections(sections, liveAgentIds, { dropEmpty = false } = {}) {
  const live = new Set(liveAgentIds);
  let removed = 0;
  let next = sections.map((s) => {
    const agentIds = s.agentIds.filter((id) => live.has(id));
    removed += s.agentIds.length - agentIds.length;
    return { ...s, agentIds };
  });
  let droppedSections = [];
  if (dropEmpty) {
    droppedSections = next.filter((s) => s.agentIds.length === 0 && !BUILTIN_SECTION_IDS.has(s.id));
    next = next.filter((s) => s.agentIds.length > 0 || BUILTIN_SECTION_IDS.has(s.id));
  }
  return { sections: next, removed, droppedSections };
}
function sectionIdByAgent(sections) {
  const map = /* @__PURE__ */ new Map();
  for (const s of sections) for (const id of s.agentIds) if (!map.has(id)) map.set(id, s.id);
  return map;
}
function sectionsDiff(before, after) {
  const b = new Map(before.map((s) => [s.id, s]));
  const a = new Map(after.map((s) => [s.id, s]));
  const changes = [];
  for (const s of after) {
    const prev = b.get(s.id);
    if (!prev) changes.push(`+ section "${s.name}" (${s.agentIds.length} agents)`);
    else {
      if (prev.name !== s.name) changes.push(`~ rename "${prev.name}" \u2192 "${s.name}"`);
      const added = s.agentIds.filter((id) => !prev.agentIds.includes(id)).length;
      const removed = prev.agentIds.filter((id) => !s.agentIds.includes(id)).length;
      if (added || removed) changes.push(`~ "${s.name}": +${added} \u2212${removed} agents`);
    }
  }
  for (const s of before) if (!a.has(s.id)) changes.push(`\u2212 section "${s.name}" (${s.agentIds.length} agents released)`);
  return changes;
}

// src/gateway.js
var GatewayError = class extends Error {
  constructor(message, extra = {}) {
    super(redact(message));
    this.name = "GatewayError";
    Object.assign(this, extra, extra.data !== void 0 ? { data: redactValue(extra.data) } : {});
    this.exitCode = extra.status === 401 || extra.status === 403 ? 2 : 1;
  }
};
var Gateway = class {
  // `runtime` (optional CursorClient-like): when set, sidebar sections are read/written on the Cursor control plane.
  constructor(session, { fetchImpl = fetch, timeoutMs = 6e4, runtime = null } = {}) {
    if (!session?.baseUrl || !session?.token) throw new GatewayError("Gateway session is missing baseUrl or token.");
    this.session = { ...session, baseUrl: String(session.baseUrl).replace(/\/+$/, "") };
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.runtime = runtime;
    this._sectionsBase = void 0;
    this.lastSectionsMirror = null;
    this._roster = null;
  }
  get baseUrl() {
    return this.session.baseUrl;
  }
  headers(extra = {}) {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.session.token}`,
      ...this.session.headers ?? {},
      ...extra
    };
  }
  async call(command, body = {}, { timeoutMs = this.timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/api/${command}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal
      });
    } catch (err) {
      throw new GatewayError(`${command}: ${err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err.message}`, { command });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const detail = data?.message ?? data?.error ?? data?.raw ?? res.statusText;
      throw new GatewayError(`${command} failed: ${res.status} ${String(detail).slice(0, 400)}`, { status: res.status, command, data });
    }
    return data;
  }
  async health({ timeoutMs = this.timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/health`, { headers: this.headers(), signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new GatewayError(`health failed: ${res.status} ${text.slice(0, 200)}`, { status: res.status });
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(`health: ${err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err.message}`, { command: "health" });
    } finally {
      clearTimeout(timer);
    }
  }
  hostStatus() {
    return this.call("getHostStatus");
  }
  // ------------------------------------------------------------ roster
  async listAgents({ fresh = false } = {}) {
    if (!fresh && this._roster) return this._roster;
    const data = await this.call("listAgents", {});
    const rows = Array.isArray(data) ? data : data?.agents ?? data?.rows ?? [];
    this._roster = rows;
    return rows;
  }
  countAgents() {
    return this.call("countAgents");
  }
  searchAgents(query, limit = 50) {
    return this.call("searchAgents", { query, limit });
  }
  createAgent({ name, description = "", title, purpose, avatarShape, avatarColor, isIntroductionSuppressed, isKickstartRequested } = {}) {
    const body = { name, description };
    if (title !== void 0) body.title = title;
    if (purpose !== void 0) body.purpose = purpose;
    if (avatarShape !== void 0) body.avatarShape = avatarShape;
    if (avatarColor !== void 0) body.avatarColor = avatarColor;
    if (isIntroductionSuppressed !== void 0) body.isIntroductionSuppressed = isIntroductionSuppressed;
    if (isKickstartRequested !== void 0) body.isKickstartRequested = isKickstartRequested;
    this._roster = null;
    return this.call("createAgent", body);
  }
  updateAgent(id, profile) {
    this._roster = null;
    return this.call("updateAgent", { id, profile });
  }
  deleteAgents(ids, { allowEmptyRoster = false } = {}) {
    this._roster = null;
    return this.call("deleteAgents", { ids, ...allowEmptyRoster ? { allowEmptyRoster: true } : {} });
  }
  deleteAgent(id) {
    this._roster = null;
    return this.call("deleteAgent", { id });
  }
  duplicateAgent(id) {
    this._roster = null;
    return this.call("duplicateAgent", { id });
  }
  setHidden(id, isHidden) {
    this._roster = null;
    return this.call("setAgentHiddenFromSidebar", { id, isHidden: Boolean(isHidden) });
  }
  setUnread(id, isUnread) {
    this._roster = null;
    return this.call("setAgentUnread", { id, isUnread: Boolean(isUnread) });
  }
  setNotifications(id, isEnabled) {
    this._roster = null;
    return this.call("setAgentNotificationsEnabled", { id, isEnabled: Boolean(isEnabled) });
  }
  setNotifyOnUpdates(id, isEnabled) {
    this._roster = null;
    return this.call("setAgentNotifyOnUpdates", { id, isEnabled: Boolean(isEnabled) });
  }
  interrupt(id, sessionId) {
    return this.call("interruptAgentRun", { id, ...sessionId ? { sessionId } : {} });
  }
  kickstart(id) {
    return this.call("kickstartAgent", { id });
  }
  createGroup({ name, description, memberAgentIds }) {
    this._roster = null;
    return this.call("createGroup", { name, ...description !== void 0 ? { description } : {}, memberAgentIds, clientNonce: randomUUID() });
  }
  setGroupMembers(id, memberAgentIds) {
    this._roster = null;
    return this.call("setGroupMembers", { id, memberAgentIds });
  }
  // ------------------------------------------------------------ conversation
  sendPrompt(agentId, prompt, extra = {}) {
    const body = { agentId, prompt, clientNonce: extra.clientNonce ?? randomUUID() };
    if (extra.replyToId) body.replyToId = extra.replyToId;
    if (extra.richText) body.richText = extra.richText;
    if (extra.attachmentPaths) body.attachmentPaths = extra.attachmentPaths;
    const sentAt = Date.now();
    return this.call("sendPrompt", body).then((r) => ({ ...r ?? {}, clientNonce: body.clientNonce, sentAt }));
  }
  promptAcceptanceStatus(clientNonce) {
    return this.call("promptAcceptanceStatus", { clientNonce });
  }
  transcriptTail(id, limit = 50) {
    return this.call("getAgentTranscriptTail", { id, limit });
  }
  transcriptPage(id, { beforeSeq, limit = 100 } = {}) {
    return this.call("getAgentTranscriptPage", { id, limit, ...beforeSeq != null ? { beforeSeq } : {} });
  }
  thread(id, rootId) {
    return this.call("getAgentThread", { id, rootId });
  }
  conversationOutline(id) {
    return this.call("getConversationOutline", { id });
  }
  subagents(id) {
    return this.call("getSubagents", { id });
  }
  asyncTasks(id) {
    return this.call("getAsyncTasks", { id });
  }
  searchMedia(query, limit = 50) {
    return this.call("searchMedia", { query, limit });
  }
  memories(id) {
    return this.call("getAgentMemories", { id });
  }
  // ------------------------------------------------------------ host settings (sections, pins, models)
  getHostSettings() {
    return this.call("getHostSettings");
  }
  async setHostSettings(patch) {
    return this.call("setHostSettings", patch);
  }
  async getSections() {
    if (this.runtime) {
      const raw = await this.runtime.getSidebarSections();
      this._sectionsBase = raw;
      return normalizeSections(raw);
    }
    const s = await this.getHostSettings();
    return normalizeSections(s?.sidebarSections);
  }
  async setSections(sections) {
    if (this.runtime) {
      const base = this._sectionsBase !== void 0 ? this._sectionsBase : await this.runtime.getSidebarSections();
      const stored = await this.runtime.setSidebarSections(sections, base);
      this._sectionsBase = stored;
      await this._mirrorSections(sections, base);
      return normalizeSections(stored);
    }
    const r = await this.setHostSettings({ sidebarSections: sections });
    return normalizeSections(Array.isArray(r?.sidebarSections) ? r.sidebarSections : sections);
  }
  // Best-effort mirror for older hosts/apps that still read host settings. Never fails setSections, but never
  // silent either: the outcome is recorded in this.lastSectionsMirror and failures warn on stderr. Skipped when the
  // server layout was empty (only built-in buckets) while the host already has a layout, so we do not clobber it.
  async _mirrorSections(sections, base) {
    try {
      const serverEmpty = normalizeSections(base).every((x) => BUILTIN_SECTION_IDS.has(x.id));
      if (serverEmpty) {
        const host = await this.getHostSettings();
        if (Array.isArray(host?.sidebarSections) && host.sidebarSections.length > 0) {
          this.lastSectionsMirror = { ok: false, skipped: true, reason: "server sections empty while host sections are non-empty" };
          return;
        }
      }
      await this.setHostSettings({ sidebarSections: sections });
      this.lastSectionsMirror = { ok: true };
    } catch (e) {
      const reason = e?.message ?? String(e);
      this.lastSectionsMirror = { ok: false, reason };
      process.stderr.write(`grokbot: warning: host sections mirror failed: ${reason}
`);
    }
  }
  async getPinned() {
    const s = await this.getHostSettings();
    return Array.isArray(s?.pinnedAgentIds) ? s.pinnedAgentIds : [];
  }
  async setPinned(ids) {
    const r = await this.setHostSettings({ pinnedAgentIds: ids });
    return Array.isArray(r?.pinnedAgentIds) ? r.pinnedAgentIds : ids;
  }
  // ------------------------------------------------------------ automations / misc
  listAutomations() {
    return this.call("listAllAutomations");
  }
  agentAutomations(id) {
    return this.call("getAgentAutomations", { id });
  }
  // ------------------------------------------------------------ events (SSE)
  async *events({ signal } = {}) {
    const res = await this.fetch(`${this.baseUrl}/events`, { headers: this.headers({ accept: "text/event-stream" }), signal });
    if (!res.ok) throw new GatewayError(`events failed: ${res.status}`, { status: res.status });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSse(chunk);
        if (evt) yield evt;
      }
    }
  }
};
function parseSse(chunk) {
  const evt = { event: "message", data: "", id: null };
  let any = false;
  for (const line of chunk.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    any = true;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") evt.event = value;
    else if (field === "data") evt.data += (evt.data ? "\n" : "") + value;
    else if (field === "id") evt.id = value;
  }
  if (!any) return null;
  try {
    evt.json = JSON.parse(evt.data);
  } catch {
    evt.json = null;
  }
  return evt;
}

// src/local.js
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { join as join2 } from "node:path";
var PERSISTENCE_DIR = join2(APP_SUPPORT, "sand-client-persistence");
var B32 = "abcdefghijklmnopqrstuvwxyz234567";
function b32decode(s) {
  const clean = s.toLowerCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out2 = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`bad base32 char ${ch}`);
    value = value << 5 | idx;
    bits += 5;
    if (bits >= 8) {
      out2.push(value >>> bits - 8 & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out2).toString("utf8");
}
function b32encode(str) {
  const buf = Buffer.from(str, "utf8");
  let bits = 0;
  let value = 0;
  let out2 = "";
  for (const byte of buf) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      out2 += B32[value >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out2 += B32[value << 5 - bits & 31];
  return out2;
}
function listSlices() {
  if (!existsSync2(PERSISTENCE_DIR)) return [];
  return readdirSync(PERSISTENCE_DIR).filter((f) => f.endsWith(".blob")).map((f) => {
    let key = null;
    try {
      key = b32decode(f.slice(0, -5));
    } catch {
    }
    const st = statSync2(join2(PERSISTENCE_DIR, f));
    return { file: f, key, size: st.size, modifiedAt: st.mtime.toISOString() };
  }).filter((s) => s.key).sort((a, b) => a.key.localeCompare(b.key));
}
function parseSliceKey(key) {
  const m = key.match(/^sand\.client\.slice\.(?:account\.([^.]+)\.)?(.+)$/);
  if (!m) return null;
  return { accountId: m[1] ? decodeURIComponent(m[1]) : null, slice: m[2] };
}
function readSlice(key) {
  const p = join2(PERSISTENCE_DIR, b32encode(key) + ".blob");
  if (!existsSync2(p)) return null;
  const parsed = JSON.parse(readFileSync2(p, "utf8"));
  return parsed?.value ?? parsed;
}
function accountIds() {
  const ids = /* @__PURE__ */ new Set();
  for (const s of listSlices()) {
    const k = parseSliceKey(s.key);
    if (k?.accountId) ids.add(k.accountId);
  }
  return [...ids];
}
function accountKey(slice, accountId) {
  const id = accountId ?? accountIds()[0];
  if (!id) return null;
  return `sand.client.slice.account.${encodeURIComponent(id).replace(/%7C/gi, "%7C")}.${slice}`;
}
function cachedRoster(accountId) {
  const key = accountKey("roster.last-roster", accountId);
  const v = key ? readSlice(key) : null;
  return v?.rows ?? [];
}
function cachedSections(accountId) {
  const key = accountKey("sidebar.last-sections", accountId);
  const v = key ? readSlice(key) : null;
  return v?.sections ?? [];
}
function cachedTranscriptAgentIds(accountId) {
  const id = accountId ?? accountIds()[0];
  return listSlices().map((s) => parseSliceKey(s.key)).filter((k) => k && k.accountId === id && k.slice.startsWith("transcript.replicas.")).map((k) => k.slice.slice("transcript.replicas.".length));
}
function cachedTranscript(agentId, accountId) {
  const key = accountKey(`transcript.replicas.${agentId}`, accountId);
  return key ? readSlice(key) : null;
}
function transcriptText(replica) {
  const entries = replica?.entries ?? replica?.rows ?? replica?.items ?? (Array.isArray(replica) ? replica : []);
  const out2 = [];
  for (const e of entries) {
    const text = extractText(e);
    if (text) out2.push({ id: e.id ?? e.entryId ?? null, seq: e.seq ?? null, kind: e.kind ?? e.type ?? null, role: e.role ?? e.author ?? e.authorKind ?? null, at: e.createdAt ?? e.at ?? e.timestamp ?? null, text });
  }
  return out2;
}
function extractText(e) {
  if (!e || typeof e !== "object") return "";
  if (typeof e.text === "string") return e.text;
  if (typeof e.markdown === "string") return e.markdown;
  if (typeof e.content === "string") return e.content;
  if (Array.isArray(e.content)) return e.content.map((c) => typeof c === "string" ? c : c?.text ?? "").join(" ");
  if (e.message) return extractText(e.message);
  if (e.payload) return extractText(e.payload);
  return "";
}
function daemonLogPath() {
  return join2(GROKBOT_HOME, "local-exec-daemon.log");
}
function desktopStatus() {
  const p = join2(APP_SUPPORT, "desktop-status.json");
  if (!existsSync2(p)) return null;
  try {
    return JSON.parse(readFileSync2(p, "utf8"));
  } catch {
    return null;
  }
}

// src/agents.js
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveAgent(roster, ref, { strict = false } = {}) {
  const r = String(ref ?? "").trim();
  if (!r) throw new UsageError("Empty agent reference.");
  const byId = roster.find((a) => a.id === r);
  if (byId) return byId;
  const exact = roster.filter((a) => (a.name ?? "").toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new UsageError(`Name "${r}" matches ${exact.length} agents (${exact.map((a) => a.id.slice(0, 8)).join(", ")}); use an id.`);
  if (strict) {
    throw new UsageError(`No agent with exact id or name "${r}". Destructive commands need the full agent id or the exact name (no prefix or partial matching).`);
  }
  if (r.length >= 4 && /^[0-9a-f-]+$/i.test(r)) {
    const pref = roster.filter((a) => a.id.toLowerCase().startsWith(r.toLowerCase()));
    if (pref.length === 1) return pref[0];
    if (pref.length > 1) throw new UsageError(`Id prefix "${r}" matches ${pref.length} agents; use more characters.`);
    if (UUID_RE.test(r)) throw new UsageError(`No agent with id ${r}.`);
  }
  const partial = roster.filter((a) => (a.name ?? "").toLowerCase().includes(r.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new UsageError(`"${r}" matches ${partial.length} agents: ${partial.map((a) => `${a.name} (${a.id.slice(0, 8)})`).join(", ")}`);
  throw new UsageError(`No agent matches "${r}".`);
}
function resolveMany(roster, refs, opts = {}) {
  const out2 = [];
  const seen = /* @__PURE__ */ new Set();
  for (const ref of refs) {
    const a = resolveAgent(roster, ref, opts);
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out2.push(a);
    }
  }
  return out2;
}
function parseDuration(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i);
  if (!m) throw new UsageError(`Bad duration "${text}" (use e.g. 30m, 12h, 7d, 2w).`);
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 7 * 864e5 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}
function filterAgents(roster, opts = {}, sections = []) {
  let rows = roster;
  if (!opts.includeHidden && opts.hidden !== true) rows = rows.filter((a) => !a.isHiddenFromSidebar);
  if (opts.hidden === true) rows = rows.filter((a) => a.isHiddenFromSidebar);
  if (opts.hidden === false) rows = rows.filter((a) => !a.isHiddenFromSidebar);
  if (opts.groups === true) rows = rows.filter((a) => a.isGroup);
  if (opts.groups === false) rows = rows.filter((a) => !a.isGroup);
  if (opts.name) {
    const re = globToRegExp(opts.name);
    rows = rows.filter((a) => re.test(a.name ?? ""));
  }
  if (opts.match) {
    const q = opts.match.toLowerCase();
    rows = rows.filter((a) => `${a.name ?? ""} ${a.description ?? ""} ${a.title ?? ""}`.toLowerCase().includes(q));
  }
  if (opts.regex) {
    const re = new RegExp(opts.regex, "i");
    rows = rows.filter((a) => re.test(a.name ?? ""));
  }
  if (opts.running) rows = rows.filter((a) => a.isRunning || a.isRunningTurn);
  if (opts.idle) rows = rows.filter((a) => !(a.isRunning || a.isRunningTurn));
  if (opts.unread) rows = rows.filter((a) => a.hasUnread || (a.unreadCount ?? 0) > 0);
  if (opts.awaiting) rows = rows.filter((a) => a.awaitingUserResponse);
  const now = Date.now();
  if (opts.idleFor) rows = rows.filter((a) => (a.lastActivityAt ?? a.updatedAt ?? a.createdAt ?? 0) < now - opts.idleFor);
  if (opts.createdBefore) rows = rows.filter((a) => (a.createdAt ?? 0) < now - opts.createdBefore);
  if (opts.createdAfter) rows = rows.filter((a) => (a.createdAt ?? 0) >= now - opts.createdAfter);
  if (opts.ids) {
    const set = new Set(opts.ids);
    rows = rows.filter((a) => set.has(a.id));
  }
  if (opts.section !== void 0) {
    const map = sectionIdByAgent(sections);
    if (opts.section === "none" || opts.section === null) rows = rows.filter((a) => !map.has(a.id));
    else rows = rows.filter((a) => map.get(a.id) === opts.section);
  }
  return rows;
}
function sortAgents(rows, by = "activity") {
  const copy = [...rows];
  const key = {
    activity: (a) => -(a.lastActivityAt ?? a.updatedAt ?? 0),
    created: (a) => -(a.createdAt ?? 0),
    name: (a) => (a.name ?? "").toLowerCase(),
    unread: (a) => -(a.unreadCount ?? 0)
  }[by];
  if (!key) throw new UsageError(`Unknown sort "${by}" (activity|created|name|unread).`);
  copy.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return copy;
}
function agentState(a) {
  if (a.isRunningTurn) return "running";
  if (a.isComposingMessage) return "composing";
  if (a.awaitingUserResponse) return "awaiting";
  if (a.isRunning) return "active";
  return "idle";
}

// src/cli.js
import { createHash } from "node:crypto";

// src/policy.js
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DENIED_FOR_AGENTS = [
  // agents/sections delete + groups members are ALLOWED under agent policy.
  // Deletes still need --yes / --confirm-count. Keep low-level surfaces denied.
  "agents duplicate",
  "agents interrupt",
  "sections import",
  "pins clear",
  "settings set",
  "gw",
  "cursor",
  "cdp",
  "app",
  "automations"
];
function resolvePolicy(env = process.env) {
  if (isInsideBox(env)) return "agent";
  const explicit = (env.GROKBOT_POLICY || "").toLowerCase();
  if (explicit === "agent" || explicit === "operator") return explicit;
  return "operator";
}
function commandPath(cmd) {
  const names = [];
  let c = cmd;
  while (c && c.parent) {
    names.unshift(c.name());
    c = c.parent;
  }
  return names.join(" ");
}
function isDenied(path, policy) {
  if (policy !== "agent") return false;
  return DENIED_FOR_AGENTS.some((d) => path === d || path.startsWith(d + " "));
}
function auditPath(env = process.env) {
  const box = boxGatewaySession(env);
  if (box) return join3(dirname(box.path), "grokbot-audit.jsonl");
  if (env.GROKBOT_AUDIT_LOG) return env.GROKBOT_AUDIT_LOG;
  return join3(homedir2(), ".grokbot", "grokbot-audit.jsonl");
}
function audit(record, env = process.env) {
  try {
    const p = auditPath(env);
    mkdirSync(dirname(p), { recursive: true, mode: 448 });
    appendFileSync(p, JSON.stringify(redactValue({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...record })) + "\n", { mode: 384 });
  } catch {
  }
}
function enforce(cmd, argv, env = process.env) {
  const policy = resolvePolicy(env);
  const path = commandPath(cmd);
  if (isDenied(path, policy)) {
    audit({ policy, path, argv, decision: "denied" }, env);
    const err = new UsageError(
      `"${path}" is not available under the agent policy. Agents may organize and delete agents/sections (with --yes gates) but not reach below the host gateway (gw/cursor/cdp/app); use "grokbot auto-review" for auto-review rules. A human runs denied commands from the Mac with GROKBOT_POLICY=operator.`
    );
    err.exitCode = 77;
    throw err;
  }
  if (policy === "agent") audit({ policy, path, argv, decision: "allowed" }, env);
  return policy;
}

// src/cli.js
var VERSION = "0.1.0";
var _gw = null;
async function gateway(opts) {
  if (_gw) return _gw;
  const session = await resolveGatewaySession({ accountScope: opts.account ?? null, prefer: opts.ensure ? "ensure" : "auto" });
  let runtime = null;
  try {
    const auth = loadCursorAuth({ accountScope: opts.account ?? null });
    if (auth) runtime = new CursorClient(auth);
  } catch {
  }
  _gw = new Gateway(session, { runtime });
  return _gw;
}
var nudgeDeps = { appState, connect: (o) => Cdp.connect(o) };
function cursor(opts) {
  const auth = loadCursorAuth({ accountScope: opts.account ?? null });
  if (!auth) throw new UsageError("No Cursor account found in the Grok Bot secret store. Sign in to Grok Bot first.");
  return new CursorClient(auth);
}
function globalOpts(cmd) {
  let c = cmd;
  while (c.parent) c = c.parent;
  return c.opts();
}
function out(cmd, value, human) {
  if (globalOpts(cmd).json) printJson(value);
  else process.stdout.write(typeof human === "function" ? human(value) : human ?? String(value) + "\n");
}
function readLines(file) {
  return readFileSync3(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
var selectionOptions = (cmd) => cmd.option("--name <glob>", "name glob, case-insensitive (e.g. 'test-*')").option("--match <text>", "substring in name/description/title").option("--regex <re>", "name regex").option("--hidden", "only agents hidden from the sidebar").option("--all", "include hidden agents").option("--groups", "only group chats").option("--no-groups", "exclude group chats").option("--running", "only agents mid-turn").option("--idle", "only agents not mid-turn").option("--unread", "only agents with unread messages").option("--awaiting", "only agents awaiting a user response").option("--idle-for <dur>", "no activity for at least <dur> (30m, 12h, 7d, 2w)").option("--created-before <dur>", "created more than <dur> ago").option("--created-after <dur>", "created within the last <dur>").option("--section <ref>", "in section (id or name), or 'none' for unsectioned").option("--ids-file <file>", "file with one agent id/name per line");
function selectionFromOpts(o, sections) {
  const f = {
    name: o.name,
    match: o.match,
    regex: o.regex,
    hidden: o.hidden ? true : void 0,
    includeHidden: Boolean(o.all || o.hidden),
    groups: o.groups === true ? true : o.groups === false ? false : void 0,
    running: o.running,
    idle: o.idle,
    unread: o.unread,
    awaiting: o.awaiting,
    idleFor: o.idleFor ? parseDuration(o.idleFor) : void 0,
    createdBefore: o.createdBefore ? parseDuration(o.createdBefore) : void 0,
    createdAfter: o.createdAfter ? parseDuration(o.createdAfter) : void 0
  };
  if (o.section !== void 0) f.section = o.section === "none" ? "none" : requireSection(sections, o.section).id;
  return f;
}
function hasSelectionFlags(o) {
  return ["name", "match", "regex", "hidden", "running", "idle", "unread", "awaiting", "idleFor", "createdBefore", "createdAfter", "section", "idsFile"].some((k) => o[k] !== void 0 && o[k] !== false) || o.groups !== void 0;
}
async function selectAgents(gw, refs, o, { requireSome = true, strict = false } = {}) {
  const roster = await gw.listAgents({ fresh: true });
  const sections = o.section !== void 0 ? await gw.getSections() : [];
  const allRefs = [...refs ?? [], ...o.idsFile ? readLines(o.idsFile) : []];
  let rows;
  if (allRefs.length > 0) {
    rows = resolveMany(roster, allRefs, { strict });
    if (hasSelectionFlags({ ...o, idsFile: void 0 })) {
      const keep = new Set(filterAgents(roster, { ...selectionFromOpts(o, sections), includeHidden: true }, sections).map((a) => a.id));
      rows = rows.filter((a) => keep.has(a.id));
    }
  } else if (hasSelectionFlags(o)) {
    rows = filterAgents(roster, selectionFromOpts(o, sections), sections);
  } else {
    throw new UsageError("Give agent refs (id, id prefix, or name) or selection flags like --name/--match/--section/--idle-for.");
  }
  if (requireSome && rows.length === 0) throw new UsageError("No agents matched.");
  return { rows, roster, sections };
}
function agentTable(rows, sections = []) {
  const byAgent = sectionIdByAgent(sections);
  const secName = new Map(sections.map((s) => [s.id, s.name]));
  return table(rows, [
    { key: "id", label: "id", format: (v) => shortId(v) },
    { key: "name", label: "name", max: 34 },
    { label: "state", get: agentState },
    { label: "unread", get: (a) => a.unreadCount ? String(a.unreadCount) : a.hasUnread ? "\u2022" : "" },
    { label: "active", get: (a) => relTime(a.lastActivityAt ?? a.updatedAt) },
    { label: "created", get: (a) => relTime(a.createdAt) },
    { label: "section", get: (a) => secName.get(byAgent.get(a.id)) ?? "" },
    { label: "flags", get: (a) => [a.isGroup && "group", a.isHiddenFromSidebar && "hidden", a.awaitingUserResponse && "awaiting"].filter(Boolean).join(",") },
    { key: "lastMessagePreview", label: "last message", max: 48 }
  ]);
}
async function confirmDestructive(cmd, rows, o, { verb, noun = "agent", requireCount = true }) {
  const g = globalOpts(cmd);
  if (!g.json) process.stdout.write(agentTable(rows));
  const summary = `${verb} ${pluralize(rows.length, noun)}`;
  if (o.dryRun) {
    out(cmd, { dryRun: true, count: rows.length, ids: rows.map((r) => r.id) }, `dry run: would ${summary}. Re-run with --yes${requireCount && rows.length > 1 ? ` --confirm-count ${rows.length}` : ""}.
`);
    return false;
  }
  if (!o.yes) {
    const err = new UsageError(`Refusing to ${summary} without --yes${requireCount && rows.length > 1 ? ` --confirm-count ${rows.length}` : ""}.`);
    err.exitCode = 3;
    throw err;
  }
  if (requireCount && rows.length > 1 && Number(o.confirmCount) !== rows.length) {
    const err = new UsageError(`${rows.length} targets matched; pass --confirm-count ${rows.length} to confirm the exact count.`);
    err.exitCode = 3;
    throw err;
  }
  return true;
}
function tailEntries(data) {
  const entries = Array.isArray(data) ? data : data?.entries ?? data?.rows ?? data?.items ?? data?.transcript ?? [];
  return Array.isArray(entries) ? entries : [];
}
var WAIT_TRANSCRIPT_WINDOW = 200;
var FALLBACK_TAIL = 20;
function entryTime(e) {
  const t = Number(e?.createdAt ?? e?.at ?? e?.timestamp ?? e?.createdAtMs);
  return Number.isFinite(t) && t > 0 ? t : null;
}
function entryText(e) {
  return transcriptText({ entries: [e] })[0]?.text ?? "";
}
function isUserEntry(e) {
  const who = String(e?.role ?? e?.author ?? e?.authorKind ?? e?.kind ?? e?.type ?? "").toLowerCase();
  return who === "" || who === "user" || who === "human";
}
var SENT_SLACK_MS = 2e3;
function entriesSince(entries, sentAt, sent = {}) {
  const { nonce, prompt, entryIds = [] } = sent;
  const want = typeof prompt === "string" ? prompt.trim() : "";
  const ids = entryIds.filter(Boolean).map(String);
  let anchor = -1;
  for (let i = entries.length - 1; i >= 0 && anchor < 0; i--) {
    const e = entries[i];
    if (ids.length && e?.id != null && ids.includes(String(e.id))) anchor = i;
    else if (typeof nonce === "string" && nonce.length >= 8 && JSON.stringify(e ?? null).includes(nonce)) anchor = i;
    else if (want && isUserEntry(e) && entryText(e).trim() === want && (entryTime(e) === null || entryTime(e) >= sentAt - SENT_SLACK_MS)) anchor = i;
  }
  if (anchor >= 0) return entries.slice(anchor);
  if (entries.some((e) => entryTime(e) !== null)) {
    const since = entries.filter((e) => (entryTime(e) ?? 0) >= sentAt - SENT_SLACK_MS);
    if (since.length) return since;
  }
  return entries.slice(-FALLBACK_TAIL);
}
function cdpTimeoutMs(o) {
  if (o?.timeout === void 0) return void 0;
  const sec = Number(o.timeout);
  if (!(Number.isFinite(sec) && sec > 0)) throw new UsageError(`--timeout must be a positive number of seconds (got "${o.timeout}").`);
  const ms = Math.round(sec * 1e3);
  if (ms > MAX_TIMER_MS) throw new UsageError(`--timeout is too large (max ${Math.floor(MAX_TIMER_MS / 1e3)} seconds; got "${o.timeout}").`);
  return ms;
}
function formatEntry(e) {
  const flat = transcriptText({ entries: [e] })[0];
  const when = e.createdAt ?? e.at ?? e.timestamp ?? e.createdAtMs;
  const who = e.role ?? e.author ?? e.authorKind ?? e.kind ?? e.type ?? "?";
  const text = flat?.text ?? "";
  return `${when ? new Date(Number(when)).toISOString().slice(11, 19) : "        "} ${String(who).padEnd(10)} ${text.replace(/\s+/g, " ").slice(0, 400)}`;
}
async function writeSections(cmd, gw, before, after, label) {
  const saved = await gw.setSections(normalizeSections(after));
  const diff = sectionsDiff(before, saved);
  out(cmd, { ok: true, sections: saved, changes: diff }, `${label}
${diff.map((d) => "  " + d).join("\n")}${diff.length ? "\n" : ""}`);
  await nudgeRenderer();
}
async function nudgeRenderer() {
  if (resolvePolicy() === "agent") return;
  try {
    const st = await nudgeDeps.appState();
    if (!st.cdpReachable) return;
    const cdp = await nudgeDeps.connect({ port: st.debugPort });
    await cdp.callDesktop("agent.getSidebarSections").catch(() => {
    });
    cdp.close();
  } catch {
  }
}
function buildProgram() {
  const program2 = new Command("grokbot").description("Operate Cursor's Grok Bot desktop app: agents, sections, pins, transcripts, host gateway, Cursor RPC, Electron CDP.").version(VERSION).option("--json", "machine-readable output").option("--account <scope>", "Cursor account scope (when more than one is signed in)").option("--ensure", "skip the app's cached gateway descriptor and mint a session via EnsureSandBox").showHelpAfterError();
  program2.hook("preAction", (_thisCommand, actionCommand) => {
    enforce(actionCommand, process.argv.slice(2));
  });
  program2.command("policy").description("Show the active execution policy (operator or agent) and what the agent policy denies").action((_, cmd) => {
    const policy = resolvePolicy();
    const box = boxGatewaySession();
    out(cmd, { policy, insideBox: Boolean(box), boxGateway: box?.path ?? null, denied: DENIED_FOR_AGENTS, auditLog: auditPath() }, () => `policy    ${policy}${box ? `  (box gateway ${box.path})` : ""}
audit log ${auditPath()}
${policy === "agent" ? "denied    " + DENIED_FOR_AGENTS.join(", ") + "\n" : "denied    (nothing; operator mode)\n"}`);
  });
  program2.command("doctor").description("Check every control surface: app, Keychain, gateway descriptor, host health, Cursor token, CDP").action(async (_, cmd) => {
    const report = { policy: resolvePolicy(), sources: describeSessionSources(), app: await appState(), gateway: null, host: null, cursor: null };
    try {
      const box = boxGatewaySession();
      const desc = box ?? loadGatewayDescriptor();
      report.gateway = desc ? { source: desc.source, host: new URL(desc.baseUrl).host, savedAt: desc.savedAtMs ? new Date(desc.savedAtMs).toISOString() : null, headers: Object.keys(desc.headers), entries: desc.entryCount ?? null, path: desc.path ?? null } : { source: null, error: "no descriptor" };
      const gw = new Gateway(desc ?? await resolveGatewaySession());
      const [health, status, count] = await Promise.all([gw.health(), gw.hostStatus(), gw.countAgents()]);
      report.host = { ok: health.ok, pid: health.pid, busy: health.isBusy, activeAgentId: health.activeAgentId, hostVersion: status.hostVersion, updateAvailable: status.hostUpdateAvailable, capabilities: status.capabilities, agents: count };
    } catch (err) {
      report.host = { error: redact(err.message) };
    }
    if (report.policy === "agent") {
      report.cursor = { skipped: "cursor control-plane is not available under the agent policy" };
    } else {
      try {
        const c = cursor(cmd.optsWithGlobals());
        report.cursor = c.tokenInfo();
        const st = await c.runState();
        report.cursor.boxState = st.state;
        report.cursor.imageUpdateAvailable = st.imageUpdateAvailable ?? null;
      } catch (err) {
        report.cursor = { error: redact(err.message) };
      }
    }
    out(cmd, report, () => {
      const L = [];
      L.push(`policy     ${report.policy}${report.gateway?.source === "box" ? `  (inside box via ${report.gateway.path})` : ""}`);
      L.push(`app        ${report.app.running ? `running pid ${report.app.pid}` : "not running"} v${report.sources.appVersion ?? "?"}  cdp ${report.app.cdpReachable ? `on :${report.app.debugPort}` : "off (grokbot app restart --debug)"}`);
      L.push(`keychain   ${report.gateway?.source ? "ok" : "no descriptor"}  descriptor ${report.gateway?.entries ?? 0} entr${report.gateway?.entries === 1 ? "y" : "ies"} saved ${report.gateway?.savedAt ?? "?"}`);
      L.push(report.host?.error ? `host       ERROR ${report.host.error}` : `host       ${report.gateway?.host}  ok=${report.host.ok} busy=${report.host.busy} version=${report.host.hostVersion}${report.host.updateAvailable ? " (update available)" : ""} agents=${report.host.agents}`);
      L.push(
        report.cursor?.skipped ? `cursor     skipped (${report.cursor.skipped})` : report.cursor?.error ? `cursor     ERROR ${report.cursor.error}` : `cursor     ${report.cursor.email ?? report.cursor.subject}  token exp ${report.cursor.expiresAt}${report.cursor.expired ? " EXPIRED" : ""}  box ${report.cursor.boxState}`
      );
      return L.join("\n") + "\n";
    });
  });
  program2.command("status").description("Host health plus roster counts").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const [health, roster, sections2] = await Promise.all([gw.health(), gw.listAgents({ fresh: true }), gw.getSections()]);
    const running = roster.filter((a) => a.isRunningTurn || a.isRunning);
    const unread = roster.filter((a) => a.hasUnread || a.unreadCount > 0);
    const hidden = roster.filter((a) => a.isHiddenFromSidebar);
    const groups2 = roster.filter((a) => a.isGroup);
    const liveIds = new Set(roster.map((a) => a.id));
    const memberIds = [...sectionIdByAgent(sections2).keys()];
    const sectioned = memberIds.filter((id) => liveIds.has(id)).length;
    const staleMemberships = memberIds.length - sectioned;
    const summary = { host: { ok: health.ok, busy: health.isBusy, activeAgentId: health.activeAgentId, startedAt: new Date(health.startedAt).toISOString() }, agents: roster.length, groups: groups2.length, running: running.length, unread: unread.length, hidden: hidden.length, sections: sections2.length, sectioned, staleMemberships, unsectioned: roster.length - sectioned, runningAgents: running.map((a) => ({ id: a.id, name: a.name })) };
    out(cmd, summary, () => `host ok=${health.ok} busy=${health.isBusy} up ${relTime(health.startedAt)}
agents ${roster.length} (${groups2.length} groups, ${hidden.length} hidden) \xB7 running ${running.length} \xB7 unread ${unread.length}
sections ${sections2.length} \xB7 sectioned ${sectioned} \xB7 unsectioned ${roster.length - sectioned}${staleMemberships ? ` \xB7 ${staleMemberships} stale membership(s) (grokbot sections prune)` : ""}
${running.map((a) => `  running: ${a.name} (${shortId(a.id)})`).join("\n")}${running.length ? "\n" : ""}`);
  });
  const agents = program2.command("agents").alias("a").description("List, inspect, create, edit, hide, and delete agents (chats)");
  selectionOptions(agents.command("list").alias("ls").description("List agents (hidden excluded unless --all/--hidden)")).option("--sort <by>", "activity|created|name|unread", "activity").option("--limit <n>", "max rows").option("--ids", "print ids only").action(async (o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const [roster, sections2] = await Promise.all([gw.listAgents({ fresh: true }), gw.getSections()]);
    let rows = sortAgents(filterAgents(roster, selectionFromOpts(o, sections2), sections2), o.sort);
    if (o.idsFile) {
      const keep = new Set(resolveMany(roster, readLines(o.idsFile)).map((a) => a.id));
      rows = rows.filter((a) => keep.has(a.id));
    }
    if (o.limit) rows = rows.slice(0, Number(o.limit));
    if (o.ids) return process.stdout.write(rows.map((a) => a.id).join("\n") + (rows.length ? "\n" : ""));
    out(cmd, rows, () => agentTable(rows, sections2) + `${rows.length} of ${roster.length}
`);
  });
  agents.command("get <ref>").description("Show one agent's full roster row").action(async (ref, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    const sections2 = await gw.getSections();
    const sec = sections2.find((s) => s.agentIds.includes(a.id));
    out(cmd, { ...a, section: sec ? { id: sec.id, name: sec.name } : null }, () => {
      const skip = /* @__PURE__ */ new Set(["avatarDataUrl", "pushMessageContent"]);
      return Object.entries({ ...a, section: sec?.name ?? null }).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`.slice(0, 300)).join("\n") + "\n";
    });
  });
  agents.command("search <query>").description("Host-side search across agents (names, descriptions, transcripts)").option("--limit <n>", "max results", "50").action(async (query, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const r = await gw.searchAgents(query, Number(o.limit));
    out(cmd, r, () => JSON.stringify(r, null, 2) + "\n");
  });
  agents.command("create <name>").description("Create a new agent (chat)").option("-d, --description <text>", "instructions / description", "").option("--title <text>").option("--purpose <text>").option("--shape <shape>", "avatar shape").option("--color <color>", "avatar color").option("--section <ref>", "put the new agent into this section").option("--no-intro", "suppress the introduction message").option("--kickstart", "ask the agent to start working immediately").action(async (name, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const sectionName = o.section ? requireSection(await gw.getSections(), o.section).name : null;
    const created = await gw.createAgent({ name, description: o.description, title: o.title, purpose: o.purpose, avatarShape: o.shape, avatarColor: o.color, isIntroductionSuppressed: o.intro === false ? true : void 0, isKickstartRequested: o.kickstart || void 0 });
    const id = created?.id ?? created?.agentId ?? created?.agent?.id;
    if (o.section && !id) {
      out(cmd, created, `created ${name} (no id in the create response)
`);
      throw new Error(`Agent "${name}" was created but the response had no id, so it was NOT placed in section "${sectionName}". Find it with \`grokbot agents list\` and use \`grokbot sections move\`.`);
    }
    if (o.section && id) {
      const before = await gw.getSections();
      await gw.setSections(assignAgents(before, o.section, [id]));
    }
    out(cmd, created, `created ${name} ${id ?? ""}${sectionName ? ` \u2192 section ${sectionName}` : ""}
`);
  });
  agents.command("rename <ref> <name>").description("Rename an agent").action(async (ref, name, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    await gw.updateAgent(a.id, { name, description: a.description ?? "" });
    out(cmd, { id: a.id, from: a.name, to: name }, `renamed ${shortId(a.id)} "${a.name}" \u2192 "${name}"
`);
  });
  agents.command("update <ref>").description("Update profile fields").option("--name <text>").option("-d, --description <text>").option("--title <text>").option("--shape <shape>").option("--color <color>").option("--notify <on|off>", "notifications enabled").option("--notify-updates <on|off>", "notify on agent updates").action(async (ref, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    const profile = { name: o.name ?? a.name, description: o.description ?? a.description ?? "" };
    if (o.title !== void 0) profile.title = o.title;
    if (o.shape !== void 0) profile.avatarShape = o.shape;
    if (o.color !== void 0) profile.avatarColor = o.color;
    if (o.name !== void 0 || o.description !== void 0 || o.title !== void 0 || o.shape !== void 0 || o.color !== void 0) await gw.updateAgent(a.id, profile);
    if (o.notify) await gw.setNotifications(a.id, o.notify === "on");
    if (o.notifyUpdates) await gw.setNotifyOnUpdates(a.id, o.notifyUpdates === "on");
    out(cmd, { id: a.id, profile }, `updated ${a.name} (${shortId(a.id)})
`);
  });
  for (const [verb, flag] of [["hide", true], ["unhide", false]]) {
    selectionOptions(agents.command(`${verb} [refs...]`).description(`${verb === "hide" ? "Hide" : "Unhide"} agents ${verb === "hide" ? "from" : "in"} the sidebar`)).action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const { rows } = await selectAgents(gw, refs, { ...o, all: true });
      for (const a of rows) await gw.setHidden(a.id, flag);
      out(cmd, { ok: true, ids: rows.map((a) => a.id) }, `${verb}: ${rows.map((a) => a.name).join(", ")}
`);
    });
  }
  for (const [verb, flag] of [["read", false], ["unread", true]]) {
    selectionOptions(agents.command(`${verb} [refs...]`).description(`Mark agents ${verb}`)).action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const { rows } = await selectAgents(gw, refs, o);
      for (const a of rows) await gw.setUnread(a.id, flag);
      out(cmd, { ok: true, ids: rows.map((a) => a.id) }, `marked ${verb}: ${rows.length}
`);
    });
  }
  agents.command("duplicate <ref>").description("Clone an agent (profile, settings, memory store; conversation cleared)").action(async (ref, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    const r = await gw.duplicateAgent(a.id);
    out(cmd, r, `duplicated ${a.name} \u2192 ${r?.id ?? JSON.stringify(r)}
`);
  });
  agents.command("interrupt <ref>").description("Interrupt the agent's current run").action(async (ref, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    const r = await gw.interrupt(a.id);
    out(cmd, r ?? { ok: true }, `interrupted ${a.name}
`);
  });
  selectionOptions(agents.command("delete [refs...]").alias("rm").description("Delete agents (full id or exact name only; no prefix matching). Prints the exact targets; needs --yes (and --confirm-count N for more than one)")).option("--dry-run", "list targets and exit").option("--yes", "actually delete").option("--confirm-count <n>", "must equal the number of matched targets when deleting more than one").option("--batch <n>", "ids per deleteAgents call", "25").option("--allow-empty", "allow the delete to empty the whole roster").action(async (refs, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const { rows } = await selectAgents(gw, refs, { ...o, all: true }, { strict: true });
    if (!await confirmDestructive(cmd, rows, o, { verb: "delete" })) return;
    const ids = rows.map((a) => a.id);
    const batch = Math.max(1, Number(o.batch));
    const results = [];
    for (let i = 0; i < ids.length; i += batch) {
      const slice = ids.slice(i, i + batch);
      const r = await gw.deleteAgents(slice, { allowEmptyRoster: Boolean(o.allowEmpty) });
      results.push(r);
      process.stderr.write(`deleted ${Math.min(i + batch, ids.length)}/${ids.length}
`);
    }
    const current = await gw.getSections();
    const deletedSet = new Set(ids);
    const touched = current.some((s) => s.agentIds.some((id) => deletedSet.has(id)));
    if (touched) await gw.setSections(assignAgents(current, null, ids));
    out(cmd, { ok: true, deleted: ids, results, sectionsUpdated: touched }, `deleted ${pluralize(ids.length, "agent")}${touched ? " (removed from sections)" : ""}
`);
  });
  agents.command("send <ref> <prompt...>").description("Send a message to an agent").option("--reply-to <entryId>").option("--wait", "wait for the turn to finish and print the tail").option("--timeout <sec>", "max seconds to wait", "300").action(async (ref, promptParts, o, cmd) => {
    const timeoutSec = Number(o.timeout);
    if (o.wait && !(Number.isFinite(timeoutSec) && timeoutSec > 0)) throw new UsageError(`--timeout must be a positive number of seconds (got "${o.timeout}").`);
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    const prompt = promptParts.join(" ");
    const r = await gw.sendPrompt(a.id, prompt, { replyToId: o.replyTo });
    if (!o.wait) return out(cmd, r, `sent to ${a.name} (${shortId(a.id)}) accepted=${r?.accepted ?? "?"} nonce=${r.clientNonce}
`);
    const deadline = Date.now() + timeoutSec * 1e3;
    let sawRunning = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const row = (await gw.listAgents({ fresh: true })).find((x) => x.id === a.id);
      const busy = row?.isRunningTurn || row?.isComposingMessage;
      if (busy) sawRunning = true;
      if (sawRunning && !busy) break;
      if (!sawRunning && Date.now() - r.sentAt > 2e4) break;
    }
    const tail = entriesSince(tailEntries(await gw.transcriptTail(a.id, WAIT_TRANSCRIPT_WINDOW)), r.sentAt, {
      nonce: r.clientNonce,
      prompt,
      entryIds: [r.entryId, r.messageId, r.userEntryId]
    });
    out(cmd, { sent: r, tail }, tail.map(formatEntry).join("\n") + "\n");
  });
  agents.command("tail <ref>").description("Print the last N transcript entries").option("-n, --limit <n>", "entries", "30").option("--raw", "print raw entries").action(async (ref, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    const data = await gw.transcriptTail(a.id, Number(o.limit));
    const entries = tailEntries(data);
    if (o.raw || globalOpts(cmd).json) return printJson(data);
    process.stdout.write(`# ${a.name} (${shortId(a.id)}) \u2014 ${entries.length} entries
` + entries.map(formatEntry).join("\n") + "\n");
  });
  agents.command("thread <ref> <rootId>").description("Print a reply thread").action(async (ref, rootId, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    printJson(await gw.thread(a.id, rootId));
  });
  agents.command("outline <ref>").description("Conversation outline (host-generated)").action(async (ref, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    printJson(await gw.conversationOutline(a.id));
  });
  agents.command("memories <ref>").description("List the agent's memories").action(async (ref, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    printJson(await gw.memories(a.id));
  });
  const sections = program2.command("sections").alias("s").description("Sidebar sections (stored in Cursor runtime settings, mirrored to host settings; the app refreshes on focus)");
  sections.command("list").alias("ls").description("List sections with member counts").option("--members", "list member agents under each section").action(async (o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const [secs, roster] = await Promise.all([gw.getSections(), o.members || globalOpts(cmd).json ? gw.listAgents({ fresh: true }) : []]);
    const byId = new Map(roster.map((a) => [a.id, a]));
    const enriched = secs.map((s, i) => ({ position: i, ...s, members: s.agentIds.map((id) => ({ id, name: byId.get(id)?.name ?? null, missing: roster.length ? !byId.has(id) : void 0 })) }));
    const unsectioned = roster.length ? roster.filter((a) => !sectionIdByAgent(secs).has(a.id) && !a.isHiddenFromSidebar).length : null;
    out(cmd, { sections: enriched, unsectioned }, () => {
      let t = table(enriched, [{ key: "position", label: "#" }, { key: "id", label: "id" }, { key: "name", label: "name", max: 40 }, { label: "agents", get: (s) => String(s.agentIds.length) }]);
      if (o.members) for (const s of enriched) t += `
${s.name}
` + s.members.map((m) => `  ${shortId(m.id)}  ${m.name ?? "(missing agent)"}`).join("\n") + "\n";
      if (unsectioned != null) t += `
unsectioned visible agents: ${unsectioned}
`;
      return t;
    });
  });
  sections.command("create <name> [refs...]").description("Create a section, optionally moving agents into it").option("--position <n>", "insert at position (0 = top)").action(async (name, refs, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const before = await gw.getSections();
    const ids = refs.length ? resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id) : [];
    const { sections: after, section } = createSection(before, name, ids, { position: o.position != null ? Number(o.position) : null });
    await writeSections(cmd, gw, before, after, `created section "${section.name}" (${section.id})`);
  });
  sections.command("rename <section> <name>").description("Rename a section").action(async (ref, name, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const before = await gw.getSections();
    const { sections: after } = renameSection(before, ref, name);
    await writeSections(cmd, gw, before, after, "renamed");
  });
  sections.command("delete <section>").alias("rm").description("Delete a section (its agents become unsectioned; nothing is deleted from the roster)").option("--yes", "confirm").action(async (ref, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const before = await gw.getSections();
    const { sections: after, section } = deleteSection(before, ref);
    if (!o.yes) {
      const err = new UsageError(`Would delete section "${section.name}" releasing ${section.agentIds.length} agents. Re-run with --yes.`);
      err.exitCode = 3;
      throw err;
    }
    await writeSections(cmd, gw, before, after, `deleted section "${section.name}"`);
  });
  async function gateSelection(cmd, rows, refs, o, verb) {
    if (refs.length > 0 && !o.dryRun) return true;
    return confirmDestructive(cmd, rows, o, { verb, requireCount: false });
  }
  selectionOptions(sections.command("move <section> [refs...]").alias("assign").description("Move agents into a section (refs or selection flags)")).option("--dry-run", "list targets and exit").option("--yes", "confirm when selecting by flags").action(async (ref, refs, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const before = await gw.getSections();
    const target = requireSection(before, ref);
    const { rows } = await selectAgents(gw, refs, { ...o, all: true });
    if (!await gateSelection(cmd, rows, refs, o, `move to "${target.name}"`)) return;
    const after = assignAgents(before, target.id, rows.map((a) => a.id));
    await writeSections(cmd, gw, before, after, `moved ${pluralize(rows.length, "agent")} \u2192 "${target.name}"`);
  });
  selectionOptions(sections.command("unassign [refs...]").description("Remove agents from whatever section they are in")).option("--dry-run", "list targets and exit").option("--yes", "confirm when selecting by flags").action(async (refs, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const before = await gw.getSections();
    const { rows } = await selectAgents(gw, refs, { ...o, all: true });
    if (!await gateSelection(cmd, rows, refs, o, "unassign")) return;
    const after = assignAgents(before, null, rows.map((a) => a.id));
    await writeSections(cmd, gw, before, after, `unassigned ${pluralize(rows.length, "agent")}`);
  });
  sections.command("reorder <section> <position>").description("Move a section to a position (0 = top)").action(async (ref, pos, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const before = await gw.getSections();
    await writeSections(cmd, gw, before, moveSection(before, ref, Number(pos)), "reordered");
  });
  sections.command("sort").description("Sort sections").option("--by <name|size>", "sort key", "name").action(async (o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const before = await gw.getSections();
    await writeSections(cmd, gw, before, sortSections(before, { by: o.by }), `sorted by ${o.by}`);
  });
  sections.command("prune").description("Drop memberships whose agent no longer exists").option("--drop-empty", "also delete sections left empty").action(async (o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const [before, roster] = await Promise.all([gw.getSections(), gw.listAgents({ fresh: true })]);
    const { sections: after, removed, droppedSections } = pruneSections(before, roster.map((a) => a.id), { dropEmpty: o.dropEmpty });
    if (removed === 0 && droppedSections.length === 0) return out(cmd, { ok: true, removed: 0 }, "nothing to prune\n");
    await writeSections(cmd, gw, before, after, `pruned ${removed} dead membership(s)${droppedSections.length ? `, dropped ${droppedSections.length} empty section(s)` : ""}`);
  });
  sections.command("export").description("Print sections JSON (pipe to a file for backup)").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    printJson(await gw.getSections());
  });
  sections.command("import <file>").description("Replace all sections from a JSON file (array of {id,name,agentIds})").option("--yes", "confirm replacement").action(async (file, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const next = normalizeSections(JSON.parse(readFileSync3(file, "utf8")));
    const before = await gw.getSections();
    if (!o.yes) {
      const err = new UsageError(`Would replace ${before.length} sections with ${next.length}. Changes:
${sectionsDiff(before, next).map((d) => "  " + d).join("\n")}
Re-run with --yes.`);
      err.exitCode = 3;
      throw err;
    }
    await writeSections(cmd, gw, before, next, `imported ${next.length} sections`);
  });
  const pins = program2.command("pins").description("Pinned agents (host settings)");
  pins.command("list").alias("ls").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const [ids, roster] = await Promise.all([gw.getPinned(), gw.listAgents({ fresh: true })]);
    const byId = new Map(roster.map((a) => [a.id, a]));
    const rows = ids.map((id) => ({ id, name: byId.get(id)?.name ?? "(missing)" }));
    out(cmd, rows, () => table(rows, [{ key: "id", label: "id", format: shortId }, { key: "name", label: "name" }]));
  });
  pins.command("add <refs...>").action(async (refs, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const ids = resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id);
    const cur2 = await gw.getPinned();
    const next = [...cur2, ...ids.filter((id) => !cur2.includes(id))];
    await gw.setPinned(next);
    out(cmd, { pinned: next }, `pinned ${ids.length}; total ${next.length}
`);
  });
  pins.command("remove <refs...>").alias("rm").action(async (refs, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const ids = new Set(resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id));
    const next = (await gw.getPinned()).filter((id) => !ids.has(id));
    await gw.setPinned(next);
    out(cmd, { pinned: next }, `unpinned; total ${next.length}
`);
  });
  pins.command("clear").option("--yes").action(async (o, cmd) => {
    if (!o.yes) throw new UsageError("Re-run with --yes to clear all pins.");
    const gw = await gateway(cmd.optsWithGlobals());
    await gw.setPinned([]);
    out(cmd, { pinned: [] }, "cleared pins\n");
  });
  const settings = program2.command("settings").description("Raw host settings (sections, pins, default model, notifications, ...)");
  settings.command("get [key]").action(async (key, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const s = await gw.getHostSettings();
    printJson(key ? s?.[key] : s);
  });
  settings.command("set <key> <json>").description("Patch one host setting with a JSON value").action(async (key, json, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const value = JSON.parse(json);
    const r = await gw.setHostSettings({ [key]: value });
    printJson(r?.[key] ?? r);
  });
  const autoReview = program2.command("auto-review").description("Grok Bot auto-review rules (host setting autoReviewInstructions); allowed for agents");
  const autoReviewValue = (s) => typeof s?.autoReviewInstructions === "string" ? s.autoReviewInstructions : "";
  const auditAutoReviewWrite = (path, value) => audit({ policy: resolvePolicy(), path, event: "auto-review-write", sha256: createHash("sha256").update(value).digest("hex"), length: value.length });
  const autoReviewOut = (cmd, value) => out(cmd, { autoReviewInstructions: value }, value === "" ? "(empty)\n" : value.endsWith("\n") ? value : value + "\n");
  autoReview.command("get").description("Print the current auto-review instructions").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    autoReviewOut(cmd, autoReviewValue(await gw.getHostSettings()));
  });
  autoReview.command("set [text]").description("Replace the auto-review instructions (text argument, --file <path>, or --stdin; exactly one). Empty values need --clear").option("--file <path>", "read the instructions from a file").option("--stdin", "read the instructions from stdin").option("--clear", "set the instructions to empty (takes no other source)").action(async (text, o, cmd) => {
    const sources = [text !== void 0, o.file !== void 0, Boolean(o.stdin)].filter(Boolean).length;
    let value;
    if (o.clear) {
      if (sources !== 0) throw new UsageError("--clear takes no text, --file, or --stdin source.");
      value = "";
    } else {
      if (sources !== 1) throw new UsageError("Give exactly one source: a [text] argument, --file <path>, or --stdin (or --clear to empty the rules).");
      value = o.file !== void 0 ? readFileSync3(o.file, "utf8") : o.stdin ? readFileSync3(0, "utf8") : text;
      if (value.trim() === "") throw new UsageError("Refusing to set empty auto-review instructions. Pass --clear to empty them deliberately.");
    }
    const gw = await gateway(cmd.optsWithGlobals());
    const previous = autoReviewValue(await gw.getHostSettings());
    process.stderr.write(`previous auto-review instructions length: ${previous.length}
`);
    const r = await gw.setHostSettings({ autoReviewInstructions: value });
    auditAutoReviewWrite("auto-review set", value);
    autoReviewOut(cmd, typeof r?.autoReviewInstructions === "string" ? r.autoReviewInstructions : value);
  });
  autoReview.command("append <text>").description("Append a line to the existing auto-review instructions; no-op if it is already the last line. Single-writer: read-modify-write, not atomic").action(async (text, _, cmd) => {
    if (text.trim() === "") throw new UsageError("Refusing to append an empty line.");
    const gw = await gateway(cmd.optsWithGlobals());
    const cur2 = autoReviewValue(await gw.getHostSettings()).replace(/\n+$/, "");
    if (cur2.split("\n").pop() === text && cur2 !== "") return autoReviewOut(cmd, cur2);
    const value = cur2 ? `${cur2}
${text}` : text;
    const r = await gw.setHostSettings({ autoReviewInstructions: value });
    auditAutoReviewWrite("auto-review append", value);
    autoReviewOut(cmd, typeof r?.autoReviewInstructions === "string" ? r.autoReviewInstructions : value);
  });
  const groups = program2.command("groups").description("Group chats (rooms of agents)");
  groups.command("create <name> <members...>").option("-d, --description <text>").action(async (name, members, o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const ids = resolveMany(await gw.listAgents({ fresh: true }), members).map((a) => a.id);
    const r = await gw.createGroup({ name, description: o.description, memberAgentIds: ids });
    out(cmd, r, `created group ${name}: ${JSON.stringify(r)}
`);
  });
  groups.command("members <group> <members...>").description("Replace a group's member list").action(async (group, members, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const roster = await gw.listAgents({ fresh: true });
    const g = resolveAgent(roster, group);
    const ids = resolveMany(roster, members).map((a) => a.id);
    const r = await gw.setGroupMembers(g.id, ids);
    out(cmd, r ?? { ok: true }, `group ${g.name} members: ${ids.length}
`);
  });
  program2.command("automations").description("List all automations (cron / listeners) across agents").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    printJson(await gw.listAutomations());
  });
  program2.command("events").description("Stream host events (server-sent events) until Ctrl-C").option("--max <n>", "stop after n events").action(async (o, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    let n = 0;
    for await (const evt of gw.events()) {
      n++;
      if (globalOpts(cmd).json) printJson({ event: evt.event, id: evt.id, data: evt.json ?? evt.data });
      else process.stdout.write(`${(/* @__PURE__ */ new Date()).toISOString().slice(11, 19)} ${evt.event} ${redact(evt.data).slice(0, 300)}
`);
      if (o.max && n >= Number(o.max)) break;
    }
  });
  program2.command("gw <command> [json]").description("Raw host gateway call: POST /api/<command> with a JSON body").action(async (command, json, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    printJson(await gw.call(command, json ? JSON.parse(json) : {}));
  });
  const cur = program2.command("cursor").description("Cursor control plane (api2.cursor.sh, GrokBotService): server-side agents, box lifecycle");
  cur.command("whoami").action(async (_, cmd) => {
    const c = cursor(cmd.optsWithGlobals());
    const info = c.tokenInfo();
    out(cmd, info, () => Object.entries(info).map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n") + "\n");
  });
  cur.command("agents").description("Server-side GrokBotAgent objects (named agents / definitions), not the box roster").option("--no-team", "exclude team agents").action(async (o, cmd) => {
    const c = cursor(cmd.optsWithGlobals());
    const { agents: agents2, slackConnections } = await c.listAgents({ includeTeamAgents: o.team !== false });
    out(cmd, { agents: agents2, slackConnections }, () => table(agents2, [{ key: "id", label: "id", format: shortId }, { key: "name", label: "name", max: 34 }, { key: "kind", label: "kind" }, { key: "harness", label: "harness" }, { key: "visibility", label: "visibility" }, { label: "created", get: (a) => relTime(Number(a.createdAtMs)) }, { key: "agentId", label: "agentId", format: shortId }]) + `${agents2.length} agents, ${slackConnections.length} slack connections
`);
  });
  cur.command("delete-agent <id>").description("Delete a server-side GrokBotAgent (control-plane object)").option("--yes").action(async (id, o, cmd) => {
    if (!o.yes) throw new UsageError("Re-run with --yes.");
    printJson(await cursor(cmd.optsWithGlobals()).deleteAgent(id));
  });
  cur.command("visibility <agentId> <owner|team>").action(async (agentId, vis, _, cmd) => {
    printJson(await cursor(cmd.optsWithGlobals()).setVisibility(agentId, vis));
  });
  cur.command("sessions <agentId>").action(async (agentId, _, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listSessions(agentId)));
  cur.command("boxes").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listBoxes()));
  cur.command("state").description("Sandbox run state").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).runState()));
  cur.command("templates").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listTemplates()));
  cur.command("computers").description("User computers registered for local exec").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listUserComputers()));
  cur.command("capabilities").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).runtimeCapabilities()));
  cur.command("ensure-sandbox").description("Mint a fresh gateway session (prints host only, never the token)").action(async (_, cmd) => {
    const r = await cursor(cmd.optsWithGlobals()).ensureSandBox();
    printJson({ ...r, gatewayToken: r.gatewayToken ? "<redacted>" : void 0, gatewayHeaders: r.gatewayHeaders ? Object.keys(r.gatewayHeaders) : void 0 });
  });
  cur.command("rpc <method> [json]").description("Raw Connect-RPC call against aiserver.v1.GrokBotService (or --service)").option("--service <name>", "e.g. aiserver.v1.DashboardService").action(async (method, json, o, cmd) => {
    printJson(await cursor(cmd.optsWithGlobals()).rpc(method, json ? JSON.parse(json) : {}, { service: o.service }));
  });
  const cdp = program2.command("cdp").description("Drive the running desktop app over Chrome DevTools Protocol");
  cdp.option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT));
  const cdpPort = async (cmd) => {
    const explicit = cmd.parent.getOptionValueSource("port") === "cli" ? Number(cmd.parent.opts().port) : null;
    if (explicit) return explicit;
    const st = await appState(DEFAULT_CDP_PORT);
    return st.debugPort ?? DEFAULT_CDP_PORT;
  };
  cdp.command("status").action(async (_, cmd) => {
    const st = await appState(await cdpPort(cmd));
    out(cmd, st, () => `running=${st.running} pid=${st.pid} debugPort=${st.debugPort} cdp=${st.cdpReachable}${st.version ? ` ${st.version.Browser}` : ""}
`);
  });
  cdp.command("targets").action(async (_, cmd) => printJson(await cdpTargets(await cdpPort(cmd))));
  cdp.command("eval <expression>").description("Evaluate JS in the renderer (promises awaited)").option("--timeout <sec>", "per-call timeout in seconds (default 30)").action(async (expr, o, cmd) => {
    const timeoutMs = cdpTimeoutMs(o);
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      printJson(await c.evaluate(expr, { timeoutMs }));
    } finally {
      c.close();
    }
  });
  cdp.command("desktop <path> [jsonArgs]").description("Call window.desktop.<path>(...args), e.g. agent.getSidebarSections").option("--timeout <sec>", "per-call timeout in seconds (default 30; known-slow calls get 120)").action(async (path, jsonArgs, o, cmd) => {
    const timeoutMs = cdpTimeoutMs(o);
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      printJson(await c.callDesktop(path, jsonArgs ? JSON.parse(jsonArgs) : [], { timeoutMs }));
    } finally {
      c.close();
    }
  });
  cdp.command("keys [path]").description("List window.desktop keys (or a nested namespace)").action(async (path, _, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      printJson(await c.desktopKeys(path ?? ""));
    } finally {
      c.close();
    }
  });
  cdp.command("text").description("Dump the rendered page text (what the user sees)").action(async (_, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      process.stdout.write(await c.pageText() + "\n");
    } finally {
      c.close();
    }
  });
  cdp.command("screenshot <file>").action(async (file, _, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      await c.bringToFront();
      await sleep(300);
      process.stdout.write(await c.screenshot(file) + "\n");
    } finally {
      c.close();
    }
  });
  cdp.command("focus").description("Bring the app window to front (also makes the app re-read host settings)").action(async (_, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      await c.bringToFront();
    } finally {
      c.close();
    }
  });
  const app = program2.command("app").description("Desktop app lifecycle");
  app.command("status").action(async (_, cmd) => {
    const st = await appState();
    const ds = desktopStatus();
    out(cmd, { ...st, desktopStatus: ds }, () => `running=${st.running} pid=${st.pid} debugPort=${st.debugPort ?? "-"} cdp=${st.cdpReachable} signedIn=${ds?.signedIn ?? "?"} appVersion=${ds?.appVersion ?? "?"}
`);
  });
  app.command("restart").description("Quit and relaunch the app").option("--debug", "relaunch with the CDP port enabled").option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT)).action(async (o, cmd) => {
    let st;
    if (o.debug) {
      st = await ensureDebugApp({ port: Number(o.port), restart: true });
    } else {
      if (!await quitApp()) throw new UsageError("Grok Bot did not quit within 20s; close it manually and retry.");
      await launchApp();
      st = await appState();
    }
    out(cmd, st, `relaunched pid=${st.pid} cdp=${st.cdpReachable ? `:${st.debugPort}` : "off"}
`);
  });
  app.command("quit").action(async (_, cmd) => {
    const ok = await quitApp();
    out(cmd, { quit: ok }, ok ? "quit\n" : "did not quit within 20s\n");
  });
  app.command("open").option("--debug", "launch with the CDP port enabled").option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT)).action(async (o, cmd) => {
    if (o.debug) return out(cmd, await ensureDebugApp({ port: Number(o.port) }), "open (debug)\n");
    await launchApp();
    out(cmd, await appState(), "open\n");
  });
  app.command("daemon-log").description("Tail the local-exec daemon log").option("-n <lines>", "lines", "40").action(async (o) => {
    const lines = readFileSync3(daemonLogPath(), "utf8").trimEnd().split("\n");
    process.stdout.write(lines.slice(-Number(o.n)).join("\n") + "\n");
  });
  const loc = program2.command("local").description("Read the app's offline caches (roster, sections, transcripts). Never authoritative for writes.");
  loc.command("slices").action(async (_, cmd) => {
    const rows = listSlices().map((s) => ({ ...s, ...parseSliceKey(s.key) ?? {} }));
    out(cmd, rows, () => table(rows, [{ key: "slice", label: "slice", max: 70 }, { key: "size", label: "bytes" }, { key: "modifiedAt", label: "modified" }]));
  });
  loc.command("roster").action(async (_, cmd) => {
    const rows = cachedRoster();
    out(cmd, rows, () => agentTable(rows, cachedSections()) + `${rows.length} cached rows
`);
  });
  loc.command("sections").action(async () => printJson(cachedSections()));
  loc.command("transcripts").description("Agent ids with a cached transcript replica").action(async () => process.stdout.write(cachedTranscriptAgentIds().join("\n") + "\n"));
  loc.command("transcript <agentId>").option("--raw").action(async (id, o) => {
    const rep = cachedTranscript(id);
    if (!rep) throw new UsageError(`No cached transcript for ${id}`);
    if (o.raw) return printJson(rep);
    process.stdout.write(transcriptText(rep).map((e) => `${e.role ?? e.kind ?? "?"}: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") + "\n");
  });
  loc.command("search <query>").description("Grep cached transcripts").action(async (q, _, cmd) => {
    const needle = q.toLowerCase();
    const roster = new Map(cachedRoster().map((a) => [a.id, a.name]));
    const hits = [];
    for (const id of cachedTranscriptAgentIds()) {
      const rep = cachedTranscript(id);
      for (const e of transcriptText(rep)) if (e.text.toLowerCase().includes(needle)) hits.push({ agentId: id, agent: roster.get(id) ?? null, role: e.role, text: e.text.replace(/\s+/g, " ").slice(0, 200) });
    }
    out(cmd, hits, () => table(hits, [{ key: "agentId", label: "agent", format: shortId }, { key: "agent", label: "name", max: 24 }, { key: "role", label: "role" }, { key: "text", label: "text", max: 100 }]) + `${hits.length} hits
`);
  });
  return program2;
}
async function run(argv) {
  const program2 = buildProgram();
  program2.exitOverride();
  try {
    await program2.parseAsync(argv);
  } catch (err) {
    if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version" || err?.code === "commander.help") return;
    if (err?.code?.startsWith?.("commander.")) {
      process.exitCode = err.exitCode ?? 64;
      return;
    }
    throw err;
  }
}

// bin/grokbot.js
run(process.argv).catch((err) => {
  const text = process.env.GROKBOT_DEBUG && err?.stack ? err.stack : `grokbot: ${err?.message ?? err}`;
  process.stderr.write(redact(text) + "\n");
  process.exit(typeof err?.exitCode === "number" ? err.exitCode : 1);
});
