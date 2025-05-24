import logging
import sys

# --- Configuration ---
LOG_FORMAT_HTTP = "[INFO] %(message)s"
LOG_FORMAT_CLI = "[INFO] %(message)s"
ERROR_FORMAT = "[ERROR] %(message)s"

# --- Logger Instances ---
# Logger for INFO messages in HTTP mode (stdout)
http_info_logger = logging.getLogger('http_info')
http_info_handler = logging.StreamHandler(sys.stdout)
http_info_handler.setFormatter(logging.Formatter(LOG_FORMAT_HTTP))
http_info_logger.addHandler(http_info_handler)
http_info_logger.setLevel(logging.INFO)
http_info_logger.propagate = False # Prevent messages from going to the root logger

# Logger for INFO messages in CLI mode (stderr)
cli_info_logger = logging.getLogger('cli_info')
cli_info_handler = logging.StreamHandler(sys.stderr)
cli_info_handler.setFormatter(logging.Formatter(LOG_FORMAT_CLI))
cli_info_logger.addHandler(cli_info_handler)
cli_info_logger.setLevel(logging.INFO)
cli_info_logger.propagate = False # Prevent messages from going to the root logger

# Logger for ERROR messages (stderr)
error_logger = logging.getLogger('error')
error_handler = logging.StreamHandler(sys.stderr)
error_handler.setFormatter(logging.Formatter(ERROR_FORMAT))
error_logger.addHandler(error_handler)
error_logger.setLevel(logging.ERROR)
error_logger.propagate = False # Prevent messages from going to the root logger

# --- Global State ---
is_http_mode = False  # Default to CLI mode

# --- Public API ---
def set_http_mode(http_mode: bool):
    """Sets the logging mode."""
    global is_http_mode
    is_http_mode = http_mode

def log(*args):
    """Logs messages at INFO level based on the current mode."""
    message = " ".join(map(str, args))
    if is_http_mode:
        http_info_logger.info(message)
    else:
        cli_info_logger.info(message)

def error(*args):
    """Logs messages at ERROR level."""
    message = " ".join(map(str, args))
    error_logger.error(message)

# Initialize with default mode (CLI) by ensuring is_http_mode is False as declared
# No explicit call to set_http_mode(False) needed here as the global default is False.

class LoggerWrapper:
    def set_http_mode(self, http_mode: bool):
        # Calls the module-level set_http_mode function
        set_http_mode(http_mode)

    def log(self, *args):
        # Calls the module-level log function
        log(*args)

    def error(self, *args):
        # Calls the module-level error function
        error(*args)

# Instantiate for easy import, making it available as 'Logger'
Logger = LoggerWrapper()
