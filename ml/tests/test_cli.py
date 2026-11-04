"""Every documented command is accepted by the command line."""
import sys

import pytest

from rea_ml import cli


@pytest.mark.parametrize("command", ["train", "predict", "serve"])
def test_command_is_registered(command, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["rea-ml", command, "--help"])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 0
    assert "usage: rea-ml" in capsys.readouterr().out
