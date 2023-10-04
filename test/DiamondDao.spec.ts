import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { DiamondDao, MockStakingHbbft, MockValidatorSetHbbft } from "../typechain-types";

const EmptyBytes = ethers.hexlify(new Uint8Array());

enum ProposalState {
  Created,
  Canceled,
  Active,
  VotingFinished,
  Accepted,
  Declined,
  Executed
};

enum DaoPhase {
  Proposal,
  Voting
}

enum Vote {
  Abstain,
  No,
  Yes
}

export function getRandomBigInt(): bigint {
  let hex = "0x" + Buffer.from(ethers.randomBytes(16)).toString("hex");

  return BigInt(hex);
}

describe("DiamondDao contract", function () {
  let users: HardhatEthersSigner[];
  let reinsertPot: HardhatEthersSigner;

  const createProposalFee = ethers.parseEther("50");

  before(async () => {
    users = await ethers.getSigners();

    reinsertPot = users[1];
  });

  async function deployFixture() {
    const daoFactory = await ethers.getContractFactory("DiamondDao");
    const mockFactory = await ethers.getContractFactory("MockValidatorSetHbbft");
    const stakingFactory = await ethers.getContractFactory("MockStakingHbbft");

    const mockValidatorSet = await mockFactory.deploy();
    await mockValidatorSet.waitForDeployment();

    const mockStaking = await stakingFactory.deploy();
    await mockStaking.waitForDeployment();

    const startTime = await time.latest();

    const daoProxy = await upgrades.deployProxy(daoFactory, [
      await mockValidatorSet.getAddress(),
      await mockStaking.getAddress(),
      reinsertPot.address,
      createProposalFee,
      startTime + 1
    ], {
      initializer: "initialize",
    });

    await daoProxy.waitForDeployment();

    const dao = daoFactory.attach(await daoProxy.getAddress()) as DiamondDao;

    return { dao, mockValidatorSet, mockStaking };
  }

  async function createProposal(
    dao: DiamondDao,
    proposer: HardhatEthersSigner,
    description?: string,
    targets?: string[],
    values?: bigint[],
    calldatas?: string[]
  ) {
    const _targets = targets ? targets : [users[1].address];
    const _values = values ? values : [ethers.parseEther('100')];
    const _calldatas = calldatas ? calldatas : [EmptyBytes];
    const _description = description ? description : "fund user";

    const proposalId = await dao.hashProposal(
      _targets,
      _values,
      _calldatas,
      _description
    );

    await dao.connect(proposer).propose(
      _targets,
      _values,
      _calldatas,
      _description,
      { value: createProposalFee }
    );

    return { proposalId, targets, values, calldatas, description }
  }

  async function swithPhase(dao: DiamondDao) {
    const phase = await dao.daoPhase();
    await time.increaseTo(phase.end + 1n);

    await dao.switchPhase();
  }

  async function addValidatorsStake(
    validatorSet: MockValidatorSetHbbft,
    staking: MockStakingHbbft,
    validators: HardhatEthersSigner[],
    stakeAmount?: bigint
  ) {
    const stake = stakeAmount ? stakeAmount : ethers.parseEther('10');

    for (const validator of validators) {
      await validatorSet.add(validator.address, validator.address, true);
      await staking.setStake(validator.address, stake);
    }
  }

  async function vote(
    dao: DiamondDao,
    proposalId: bigint,
    voters: HardhatEthersSigner[],
    vote: Vote
  ) {
    for (const voter of voters) {
      await dao.connect(voter).vote(proposalId, vote);
    }
  }

  describe("initializer", async function () {
    it("should not deploy contract with invalid ValidatorSet address", async function () {
      const daoFactory = await ethers.getContractFactory("DiamondDao");
      const startTime = await time.latest();

      await expect(
        upgrades.deployProxy(daoFactory, [
          ethers.ZeroAddress,
          users[1].address,
          users[2].address,
          createProposalFee,
          startTime + 1
        ], {
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(daoFactory, "InvalidArgument");
    });

    it("should not deploy contract with invalid StakingHbbft address", async function () {
      const daoFactory = await ethers.getContractFactory("DiamondDao");
      const startTime = await time.latest();

      await expect(
        upgrades.deployProxy(daoFactory, [
          users[1].address,
          ethers.ZeroAddress,
          users[2].address,
          createProposalFee,
          startTime + 1
        ], {
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(daoFactory, "InvalidArgument");
    });

    it("should not deploy contract with invalid reinsert pot address", async function () {
      const daoFactory = await ethers.getContractFactory("DiamondDao");
      const startTime = await time.latest();

      await expect(
        upgrades.deployProxy(daoFactory, [
          users[1].address,
          users[2].address,
          ethers.ZeroAddress,
          createProposalFee,
          startTime + 1
        ], {
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(daoFactory, "InvalidArgument");
    });

    it("should not deploy contract with zero create proposal fee address", async function () {
      const daoFactory = await ethers.getContractFactory("DiamondDao");
      const startTime = await time.latest();

      await expect(
        upgrades.deployProxy(daoFactory, [
          users[1].address,
          users[2].address,
          users[3].address,
          0n,
          startTime + 1
        ], {
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(daoFactory, "InvalidArgument");
    });

    it("should not deploy contract with invalid start timestamp", async function () {
      const daoFactory = await ethers.getContractFactory("DiamondDao");
      const startTime = await time.latest();

      await expect(
        upgrades.deployProxy(daoFactory, [
          users[1].address,
          users[2].address,
          users[3].address,
          createProposalFee,
          startTime - 10
        ], {
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(daoFactory, "InvalidStartTimestamp");
    });

    it("should not allow reinitialization", async function () {
      const daoFactory = await ethers.getContractFactory("DiamondDao");
      const startTime = await time.latest();

      const dao = await upgrades.deployProxy(daoFactory, [
        users[1].address,
        users[2].address,
        users[3].address,
        createProposalFee,
        startTime + 1
      ], {
        initializer: "initialize",
      });

      await dao.waitForDeployment();

      await expect(
        dao.initialize(
          users[1].address,
          users[2].address,
          users[3].address,
          createProposalFee,
          startTime + 1
        )
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });
  });

  describe("switchPhase", async function () {
    it("should not switch DAO phase before its end", async function () {
      const { dao } = await loadFixture(deployFixture);
      const daoPhaseBefore = await dao.daoPhase();

      await expect(dao.switchPhase()).to.not.emit(dao, "SwitchDaoPhase");

      const daoPhaseAfter = await dao.daoPhase();

      expect(Object.values(daoPhaseBefore)).to.deep.equal(Object.values(daoPhaseAfter));
    });

    it("should switch DAO phase and emit event", async function () {
      const { dao } = await loadFixture(deployFixture);
      const daoPhaseBefore = await dao.daoPhase();

      await time.increaseTo(daoPhaseBefore.end);

      const timestamp = await time.latest();
      const daoPhaseDuration = await dao.DAO_PHASE_DURATION();

      const expectedStartTimestamp = BigInt(timestamp + 1);
      const expectedEndTimestamp = BigInt(expectedStartTimestamp) + daoPhaseDuration;

      await expect(
        dao.switchPhase()
      ).to.emit(dao, "SwitchDaoPhase")
        .withArgs(DaoPhase.Voting, expectedStartTimestamp, expectedEndTimestamp);

      const daoPhase = await dao.daoPhase();

      expect(daoPhase.phase).to.equal(DaoPhase.Voting);
      expect(daoPhase.start).to.equal(expectedStartTimestamp);
      expect(daoPhase.end).to.equal(expectedEndTimestamp);
    });

    it("should switch DAO phase from Proposal to Voting", async function () {
      const { dao } = await loadFixture(deployFixture);

      await swithPhase(dao);
      const daoPhase = await dao.daoPhase();

      expect(daoPhase.phase).to.equal(DaoPhase.Voting);
    });

    it("should switch DAO phase to Voting and set Active proposal state", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposals = [];

      proposals.push(await createProposal(dao, users[2], users[2].address));
      proposals.push(await createProposal(dao, users[3], users[3].address));
      proposals.push(await createProposal(dao, users[4], users[4].address));

      const currentProposals: bigint[] = await dao.getCurrentPhaseProposals();

      expect(currentProposals.length).to.equal(proposals.length);
      for (const proposal of proposals) {
        expect((await dao.getProposal(proposal.proposalId)).state).to.equal(ProposalState.Created);
        expect(currentProposals.includes(proposal.proposalId));
      }

      await swithPhase(dao);

      for (const proposal of proposals) {
        expect((await dao.getProposal(proposal.proposalId)).state).to.equal(ProposalState.Active);
      }
    });

    it("should switch DAO phase from Voting to Proposal and clear current phase proposals", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposals = [];

      proposals.push(await createProposal(dao, users[2], users[2].address));
      proposals.push(await createProposal(dao, users[3], users[3].address));
      proposals.push(await createProposal(dao, users[4], users[4].address));

      for (const proposal of proposals) {
        expect((await dao.getProposal(proposal.proposalId)).state).to.equal(ProposalState.Created);
      }

      await swithPhase(dao);
      await swithPhase(dao);

      const daoPhase = await dao.daoPhase();

      expect(daoPhase.phase).to.equal(DaoPhase.Proposal);

      for (const proposal of proposals) {
        expect((await dao.getProposal(proposal.proposalId)).state).to.equal(ProposalState.VotingFinished);
      }

      expect(await dao.getCurrentPhaseProposals()).to.be.empty;
    });
  });

  describe("propose", async function () {
    it("should revert propose with empty targets array", async function () {
      const { dao } = await loadFixture(deployFixture);

      const targets: string[] = [];
      const values: bigint[] = [];
      const calldatas: string[] = [];

      await expect(
        dao.propose(targets, values, calldatas, "test", { value: createProposalFee })
      ).to.be.revertedWithCustomError(dao, "InvalidArgument")
    });

    it("should revert propose with targets.length != values.length", async function () {
      const { dao } = await loadFixture(deployFixture);

      const targets = [users[1].address, users[2].address];
      const values = [1n];
      const calldatas = [EmptyBytes, EmptyBytes];

      await expect(
        dao.propose(targets, values, calldatas, "test", { value: createProposalFee })
      ).to.be.revertedWithCustomError(dao, "InvalidArgument")
    });

    it("should revert propose with targets.length != calldatas.length", async function () {
      const { dao } = await loadFixture(deployFixture);

      const targets = [users[1].address];
      const values = [1n, 1n];
      const calldatas = [EmptyBytes, EmptyBytes];

      await expect(
        dao.propose(targets, values, calldatas, "test", { value: createProposalFee })
      ).to.be.revertedWithCustomError(dao, "InvalidArgument")
    });

    it("should revert propose without proposal fee payment", async function () {
      const { dao } = await loadFixture(deployFixture);

      const targets = [users[3].address];
      const values = [1n];
      const calldatas = [EmptyBytes];

      await expect(
        dao.propose(targets, values, calldatas, "test", { value: 0n })
      ).to.be.revertedWithCustomError(dao, "InsufficientFunds")
    });

    it("should revert propose if same proposal already exists", async function () {
      const { dao } = await loadFixture(deployFixture);

      const targets = [users[3].address];
      const values = [ethers.parseEther("1")];
      const calldatas = [EmptyBytes];
      const description = "test";

      const proposalId = await dao.hashProposal(
        targets,
        values,
        calldatas,
        description
      );

      expect(await dao.propose(targets, values, calldatas, description, { value: createProposalFee }));

      await expect(
        dao.propose(targets, values, calldatas, description, { value: createProposalFee })
      ).to.be.revertedWithCustomError(dao, "ProposalAlreadyExist")
        .withArgs(proposalId);
    });

    it("should revert propose on Voting phase", async function () {
      const { dao } = await loadFixture(deployFixture);

      await swithPhase(dao);

      const targets = [users[3].address];
      const values = [1n];
      const calldatas = [EmptyBytes];

      await expect(
        dao.propose(targets, values, calldatas, "test", { value: createProposalFee })
      ).to.be.revertedWithCustomError(dao, "UnavailableInCurrentPhase")
        .withArgs(DaoPhase.Voting);
    });

    it("should revert propose if fee transfer failed", async function () {
      const daoFactory = await ethers.getContractFactory("DiamondDao");
      const mockFactory = await ethers.getContractFactory("MockValidatorSetHbbft");

      const mockValidatorSet = await mockFactory.deploy();
      await mockValidatorSet.waitForDeployment();

      const startTime = await time.latest();

      const daoProxy = await upgrades.deployProxy(daoFactory, [
        await mockValidatorSet.getAddress(),
        await mockValidatorSet.getAddress(),
        await mockValidatorSet.getAddress(),
        createProposalFee,
        startTime + 1
      ], {
        initializer: "initialize",
      });

      await daoProxy.waitForDeployment();

      const dao = daoFactory.attach(await daoProxy.getAddress()) as DiamondDao;

      const targets = [users[3].address];
      const values = [ethers.parseEther("1")];
      const calldatas = [EmptyBytes];
      const description = "test";

      await expect(
        dao.propose(
          targets,
          values,
          calldatas,
          description,
          { value: createProposalFee }
        )
      ).to.be.revertedWithCustomError(dao, "TransferFailed")
        .withArgs(await dao.getAddress(), await mockValidatorSet.getAddress(), createProposalFee);
    });

    it("should revert propose if limit was reached", async function () {
      const { dao } = await loadFixture(deployFixture);

      for (let i = 0; i < 100; ++i) {
        expect(await createProposal(dao, users[1], `proposal ${i}`));
      }

      await expect(
        dao.connect(users[2]).propose(
          [users[3].address],
          [ethers.parseEther('10')],
          [EmptyBytes],
          "should fail",
          { value: createProposalFee }
        )
      ).to.be.revertedWithCustomError(dao, "NewProposalsLimitExceeded");
    });

    it("should create proposal and transfer fee to reinsert pot", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[2];

      const targets = [users[3].address];
      const values = [ethers.parseEther("1")];
      const calldatas = [EmptyBytes];
      const description = "test";

      await expect(
        dao.connect(proposer).propose(targets, values, calldatas, description, { value: createProposalFee })
      ).to.changeEtherBalances(
        [proposer.address, reinsertPot.address],
        [-createProposalFee, createProposalFee]
      );
    });

    it("should create proposal and emit event", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[2];

      const targets = [users[3].address];
      const values = [ethers.parseEther("1")];
      const calldatas = [EmptyBytes];
      const description = "test";

      const proposalId = await dao.hashProposal(
        targets,
        values,
        calldatas,
        description
      );

      await expect(
        dao.connect(proposer).propose(targets, values, calldatas, description, { value: createProposalFee })
      ).to.emit(dao, "ProposalCreated")
        .withArgs(
          proposer.address,
          proposalId,
          targets,
          values,
          calldatas,
          description
        );
    });

    it("should create proposal and save data", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[2];

      const targets = [users[3].address];
      const values = [ethers.parseEther("1")];
      const calldatas = [EmptyBytes];
      const description = "test";

      const proposalId = await dao.hashProposal(
        targets,
        values,
        calldatas,
        description
      );

      expect(await dao.connect(proposer).propose(
        targets,
        values,
        calldatas,
        description,
        { value: createProposalFee }
      ));

      expect(await dao.proposalExists(proposalId)).to.be.true;

      const savedData = await dao.getProposal(proposalId);

      expect(Object.values(savedData)).to.deep.equal([
        proposer.address,
        BigInt(ProposalState.Created),
        targets,
        values,
        calldatas,
        description
      ]);
    });

    it("should create proposal and update statistical data", async function () {
      const { dao } = await loadFixture(deployFixture);

      const statisticsBefore = await dao.statistic();

      const proposer = users[1];
      await createProposal(dao, proposer);

      const statisticsAfter = await dao.statistic();
      expect(statisticsAfter.total).to.equal(statisticsBefore.total + 1n);
    });
  });

  describe("cancel", async function () {
    it("should revert cancel for non-existing proposal", async function () {
      const { dao } = await loadFixture(deployFixture);

      const nonExistingProposalId = getRandomBigInt();

      await expect(
        dao.cancel(nonExistingProposalId, "test")
      ).to.be.revertedWithCustomError(dao, "ProposalNotExist")
        .withArgs(nonExistingProposalId);
    });

    it("should revert cancel not by proposal creator", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[1];
      const caller = users[2];

      const { proposalId } = await createProposal(dao, proposer);

      await expect(
        dao.connect(caller).cancel(proposalId, "test")
      ).to.be.revertedWithCustomError(dao, "OnlyProposer");
    });

    it("should revert cancel of active proposal", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[1];
      const { proposalId } = await createProposal(dao, proposer);

      await swithPhase(dao);

      await expect(
        dao.connect(proposer).cancel(proposalId, "reason")
      ).to.be.revertedWithCustomError(dao, "UnexpectedProposalState")
        .withArgs(proposalId, ProposalState.Active);
    });

    it("should cancel proposal and emit event", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[1];
      const reason = "proposal-cancel-reason";

      const { proposalId } = await createProposal(dao, proposer);

      await expect(
        dao.connect(proposer).cancel(proposalId, reason)
      ).to.emit(dao, "ProposalCanceled")
        .withArgs(proposer.address, proposalId, reason);
    });

    it("should cancel proposal and change its status to canceled", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[1];
      const { proposalId } = await createProposal(dao, proposer);

      let proposalData = await dao.getProposal(proposalId);
      expect(proposalData.state).to.be.equal(ProposalState.Created);

      expect(await dao.connect(proposer).cancel(proposalId, "reason"));

      proposalData = await dao.getProposal(proposalId);
      expect(proposalData.state).to.be.equal(ProposalState.Canceled);
    });

    it("should cancel proposal and update statistics", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[1];
      const { proposalId } = await createProposal(dao, proposer);

      const statisticsBefore = await dao.statistic();

      expect(await dao.connect(proposer).cancel(proposalId, "reason"));

      const statisticsAfter = await dao.statistic();
      expect(statisticsAfter.canceled).to.be.equal(statisticsBefore.canceled + 1n);
    });
  });

  describe("vote", async function () {
    it("should revert vote for non-existing proposal", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposalId = getRandomBigInt();

      await expect(
        dao.vote(proposalId, Vote.Yes)
      ).to.be.revertedWithCustomError(dao, "ProposalNotExist")
        .withArgs(proposalId);
    });

    it("should revert vote on wrong phase", async function () {
      const { dao } = await loadFixture(deployFixture);
      const proposer = users[10];

      const { proposalId } = await createProposal(dao, proposer, "a");

      await expect(
        dao.vote(proposalId, Vote.Yes)
      ).to.be.revertedWithCustomError(dao, "UnavailableInCurrentPhase")
        .withArgs(DaoPhase.Proposal);
    });

    it("should revert vote not by validator", async function () {
      const { dao } = await loadFixture(deployFixture);
      const proposer = users[10];
      const voter = users[9];

      const { proposalId } = await createProposal(dao, proposer, "a");

      await swithPhase(dao);

      await expect(
        dao.connect(voter).vote(proposalId, Vote.Yes)
      ).to.be.revertedWithCustomError(dao, "OnlyValidators")
        .withArgs(voter.address);
    });

    it("should submit vote by validator and emit event", async function () {
      const { dao, mockValidatorSet } = await loadFixture(deployFixture);

      const proposer = users[10];
      const voter = users[9];
      const vote = Vote.Yes;

      const { proposalId } = await createProposal(dao, proposer, "a");

      await mockValidatorSet.add(voter.address, voter.address, true);
      await swithPhase(dao);

      await expect(
        dao.connect(voter).vote(proposalId, vote)
      ).to.emit(dao, "SubmitVote")
        .withArgs(voter.address, proposalId, vote);
    });

    it("should submit vote and add voter to set", async function () {
      const { dao, mockValidatorSet } = await loadFixture(deployFixture);

      const proposer = users[10];
      const voters = users.slice(5, 10);

      const vote = Vote.Yes;

      const { proposalId } = await createProposal(dao, proposer, "a");
      await swithPhase(dao);

      for (const voter of voters) {
        await mockValidatorSet.add(voter.address, voter.address, true);
        expect(await dao.connect(voter).vote(proposalId, vote));
      }

      const votersAddressList = voters.map(x => x.address);

      const savidVotersCount = await dao.getProposalVotersCount(proposalId);
      const savedVotersList = await dao.getProposalVoters(proposalId);

      expect(savidVotersCount).to.equal(savedVotersList.length);
      expect(savidVotersCount).to.equal(BigInt(votersAddressList.length));

      expect(savedVotersList).to.deep.equal(votersAddressList);
    });

    it("should submit vote and save its data", async function () {
      const { dao, mockValidatorSet } = await loadFixture(deployFixture);

      const proposer = users[10];

      const voter = users[11];
      const vote = Vote.Yes;

      const { proposalId } = await createProposal(dao, proposer, "a");
      await swithPhase(dao);

      await mockValidatorSet.add(voter.address, voter.address, true);
      expect(await dao.connect(voter).vote(proposalId, vote));

      const voteTimestamp = await time.latest();
      const savedVoteData = await dao.votes(proposalId, voter.address);

      expect(Object.values(savedVoteData)).to.deep.equal([voteTimestamp, vote, ""]);
    });
  });

  describe("voteWithReason", async function () {
    it("should revert vote with reason for non-existing proposal", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposalId = getRandomBigInt();

      await expect(
        dao.voteWithReason(proposalId, Vote.Yes, "reason")
      ).to.be.revertedWithCustomError(dao, "ProposalNotExist")
        .withArgs(proposalId);
    });

    it("should revert vote with reason on wrong phase", async function () {
      const { dao } = await loadFixture(deployFixture);
      const proposer = users[10];

      const { proposalId } = await createProposal(dao, proposer, "a");

      await expect(
        dao.voteWithReason(proposalId, Vote.Yes, "reason")
      ).to.be.revertedWithCustomError(dao, "UnavailableInCurrentPhase")
        .withArgs(DaoPhase.Proposal);
    });

    it("should revert vote with reason not by validator", async function () {
      const { dao } = await loadFixture(deployFixture);
      const proposer = users[10];
      const voter = users[9];

      const { proposalId } = await createProposal(dao, proposer, "a");

      await swithPhase(dao);

      await expect(
        dao.connect(voter).voteWithReason(proposalId, Vote.Yes, "reason")
      ).to.be.revertedWithCustomError(dao, "OnlyValidators")
        .withArgs(voter.address);
    });

    it("should submot vote with reason by validator and emit event", async function () {
      const { dao, mockValidatorSet } = await loadFixture(deployFixture);

      const proposer = users[10];
      const voter = users[9];
      const vote = Vote.Yes;
      const reason = "vote reason"

      const { proposalId } = await createProposal(dao, proposer, "a");

      await mockValidatorSet.add(voter.address, voter.address, true);
      await swithPhase(dao);

      await expect(
        dao.connect(voter).voteWithReason(proposalId, vote, reason)
      ).to.emit(dao, "SubmitVoteWithReason")
        .withArgs(voter.address, proposalId, vote, reason);
    });

    it("should submit vote with reason and add voter to set", async function () {
      const { dao, mockValidatorSet } = await loadFixture(deployFixture);

      const proposer = users[10];

      const voters = users.slice(5, 10);
      const vote = Vote.Yes;

      const { proposalId } = await createProposal(dao, proposer, "a");
      await swithPhase(dao);

      for (const voter of voters) {
        await mockValidatorSet.add(voter.address, voter.address, true);
        expect(await dao.connect(voter).voteWithReason(proposalId, vote, "reason"));
      }

      const votersAddressList = voters.map(x => x.address);

      const savidVotersCount = await dao.getProposalVotersCount(proposalId);
      const savedVotersList = await dao.getProposalVoters(proposalId);

      expect(savidVotersCount).to.equal(savedVotersList.length);
      expect(savidVotersCount).to.equal(BigInt(votersAddressList.length));

      expect(savedVotersList).to.deep.equal(votersAddressList);
    });

    it("should submit vote with reason and save its data", async function () {
      const { dao, mockValidatorSet } = await loadFixture(deployFixture);

      const proposer = users[10];

      const voter = users[11];
      const vote = Vote.Yes;
      const reason = "vote reason"

      const { proposalId } = await createProposal(dao, proposer, "a");
      await swithPhase(dao);

      await mockValidatorSet.add(voter.address, voter.address, true);
      expect(await dao.connect(voter).voteWithReason(proposalId, vote, reason));

      const voteTimestamp = await time.latest();
      const savedVoteData = await dao.votes(proposalId, voter.address);

      expect(Object.values(savedVoteData)).to.deep.equal([voteTimestamp, vote, reason]);
    });
  });

  describe("finalize", async function () {
    it("should revert finalize of non-existing proposal", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposalId = getRandomBigInt();

      await expect(
        dao.finalize(proposalId)
      ).to.be.revertedWithCustomError(dao, "ProposalNotExist")
        .withArgs(proposalId);
    });

    it("should revert finalize of proposal with unexpected state", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[2];
      const { proposalId } = await createProposal(dao, proposer);

      await expect(
        dao.finalize(proposalId)
      ).to.be.revertedWithCustomError(dao, "UnexpectedProposalState")
        .withArgs(proposalId, ProposalState.Created);
    });

    it("should finalize accepted proposal and emit event", async function () {
      const { dao, mockValidatorSet, mockStaking } = await loadFixture(deployFixture);

      const proposer = users[1];
      const voters = users.slice(10, 25);

      const { proposalId } = await createProposal(dao, proposer);

      await addValidatorsStake(mockValidatorSet, mockStaking, voters);

      await swithPhase(dao);

      await vote(dao, proposalId, voters.slice(0, 10), Vote.Yes);
      await vote(dao, proposalId, voters.slice(10, 12), Vote.Abstain);
      await vote(dao, proposalId, voters.slice(12), Vote.No);

      await swithPhase(dao);

      await expect(
        dao.connect(proposer).finalize(proposalId)
      ).to.emit(dao, "VotingFinalized")
        .withArgs(proposer.address, proposalId, true);

      expect((await dao.getProposal(proposalId)).state).to.equal(ProposalState.Accepted);
    });

    it("should finalize accepted proposal and update statistics", async function () {
      const voters = users.slice(10, 20);

      const { dao, mockValidatorSet, mockStaking } = await loadFixture(deployFixture);
      const { proposalId } = await createProposal(dao, users[1]);

      const statisticBefore = await dao.statistic();

      await addValidatorsStake(mockValidatorSet, mockStaking, voters);

      await swithPhase(dao);
      await vote(dao, proposalId, voters, Vote.Yes);
      await swithPhase(dao);

      expect(await dao.finalize(proposalId));

      const statisticsAfter = await dao.statistic();

      expect(statisticsAfter.accepted).to.equal(statisticBefore.accepted + 1n);
    });

    it("should finalize declined proposal and emit event", async function () {
      const { dao, mockValidatorSet, mockStaking } = await loadFixture(deployFixture);

      const proposer = users[1];
      const voters = users.slice(10, 25);

      const { proposalId } = await createProposal(dao, proposer);

      await addValidatorsStake(mockValidatorSet, mockStaking, voters);

      await swithPhase(dao);

      await vote(dao, proposalId, voters.slice(0, 10), Vote.No);
      await vote(dao, proposalId, voters.slice(10), Vote.Yes);

      await swithPhase(dao);

      await expect(
        dao.connect(proposer).finalize(proposalId)
      ).to.emit(dao, "VotingFinalized")
        .withArgs(proposer.address, proposalId, false);

      expect((await dao.getProposal(proposalId)).state).to.equal(ProposalState.Declined);
    });

    it("should finalize declined proposal and update statistics", async function () {
      const voters = users.slice(10, 20);

      const { dao, mockValidatorSet, mockStaking } = await loadFixture(deployFixture);
      const { proposalId } = await createProposal(dao, users[1]);

      const statisticBefore = await dao.statistic();

      await addValidatorsStake(mockValidatorSet, mockStaking, voters);

      await swithPhase(dao);
      await vote(dao, proposalId, voters, Vote.No);
      await swithPhase(dao);

      expect(await dao.finalize(proposalId));

      const statisticsAfter = await dao.statistic();

      expect(statisticsAfter.declined).to.equal(statisticBefore.declined + 1n);
    });
  });

  describe("execute", async function () {
    it("should revert execute of non-existing proposal", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposalId = getRandomBigInt();

      await expect(
        dao.execute(proposalId)
      ).to.be.revertedWithCustomError(dao, "ProposalNotExist")
        .withArgs(proposalId);
    });

    it("should revert execute of proposal with unexpected state", async function () {
      const { dao } = await loadFixture(deployFixture);

      const proposer = users[2];
      const { proposalId } = await createProposal(dao, proposer);

      await expect(
        dao.execute(proposalId)
      ).to.be.revertedWithCustomError(dao, "UnexpectedProposalState")
        .withArgs(proposalId, ProposalState.Created);
    });

    it("should revert execute of declined proposal", async function () {
      const voters = users.slice(10, 25);

      const { dao, mockValidatorSet, mockStaking } = await loadFixture(deployFixture);
      const { proposalId } = await createProposal(dao, users[1]);

      await addValidatorsStake(mockValidatorSet, mockStaking, voters);

      await swithPhase(dao);
      await vote(dao, proposalId, voters, Vote.No);
      await swithPhase(dao);

      expect(await dao.finalize(proposalId));

      await expect(
        dao.execute(proposalId)
      ).to.be.revertedWithCustomError(dao, "UnexpectedProposalState")
        .withArgs(proposalId, ProposalState.Declined);
    });

    it("should execute accepted proposal", async function () {
      const voters = users.slice(10, 25);

      const { dao, mockValidatorSet, mockStaking } = await loadFixture(deployFixture);

      const proposer = users[4];
      const userToFund = users[5];
      const fundAmount = ethers.parseEther('151');

      const { proposalId } = await createProposal(
        dao,
        users[1],
        "fund user 5",
        [userToFund.address],
        [fundAmount],
        [EmptyBytes]
      );

      await proposer.sendTransaction({
        to: await dao.getAddress(),
        value: fundAmount
      });

      expect(await dao.governancePot()).to.equal(fundAmount);

      await addValidatorsStake(mockValidatorSet, mockStaking, voters);

      await swithPhase(dao);
      await vote(dao, proposalId, voters, Vote.Yes);
      await swithPhase(dao);

      expect(await dao.finalize(proposalId));

      const tx = dao.connect(proposer).execute(proposalId);

      await expect(tx)
        .to.emit(dao, "ProposalExecuted")
        .withArgs(proposer.address, proposalId)

      await expect(tx).to.changeEtherBalances(
        [await dao.getAddress(), userToFund.address],
        [-fundAmount, fundAmount],
      );

      expect(await dao.governancePot()).to.equal(0);
    });
  });

  describe("setCreateProposalFee", async function () {
    it("should revert calling function by unauthorized account", async function () {
      const { dao } = await loadFixture(deployFixture);
      const caller = users[4];

      await expect(
        dao.connect(caller).setCreateProposalFee(1n)
      ).to.be.revertedWithCustomError(dao, "OnlyGovernance");
    });
  });
});
